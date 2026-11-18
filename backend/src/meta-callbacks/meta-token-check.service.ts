import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import { MetaGraphClient } from '../meta/meta-graph.client.js';
import { MetaGraphError } from '../meta/meta-graph.errors.js';
import {
  applyTokenCheckResult,
  listConnectionsForTokenCheck,
  type TokenCheckRow,
} from './meta-callbacks.queries.js';
import {
  type DebugTokenOutcome,
  decideTokenStatus,
  sameInstant,
  type TokenCheckVerdict,
} from './meta-token-check.rules.js';

/** Connections read per page (keyset); one Graph call per row, one after the other. */
export const TOKEN_CHECK_PAGE_SIZE = 100;
/** Pause between two `debug_token` calls (≤ 5 calls/s from one process; rate-limit friendly). */
export const TOKEN_CHECK_PAUSE_MS = 200;

export interface TokenCheckCounts {
  /** Rows a `debug_token` call was made for. */
  checked: number;
  /** Verdict = the stored status and expiry: nothing written. */
  unchanged: number;
  toActive: number;
  toNeedsReauth: number;
  /** Status kept, `token_expires_at` refreshed from Meta. */
  expiryRefreshed: number;
  /** The row changed between read and write (Deauthorize / re-connect won): nothing written. */
  raced: number;
  /** Graph error other than `token_invalid` (transient, network, …): row left for tomorrow. */
  graphErrors: number;
  /** Token could not be decrypted with the row's context: row left, warned. */
  undecryptable: number;
  /** Not checked because Meta rate-limited this run. */
  notChecked: number;
}

export type TokenCheckOutcome =
  | {
      kind: 'token_check';
      counts: TokenCheckCounts;
      rateLimited: boolean;
    }
  | {
      kind: 'token_check_skipped';
      reason: 'meta_not_configured' | 'cipher_not_configured';
    };

interface Pending {
  row: TokenCheckRow;
  verdict: Extract<TokenCheckVerdict, { action: 'set' }>;
}

const emptyCounts = (): TokenCheckCounts => ({
  checked: 0,
  unchanged: 0,
  toActive: 0,
  toNeedsReauth: 0,
  expiryRefreshed: 0,
  raced: 0,
  graphErrors: 0,
  undecryptable: 0,
  notChecked: 0,
});

/**
 * Daily `debug_token` check (M4-T7, Module 4 D8): every ACTIVE + NEEDS_REAUTH connection's user
 * token is checked with Meta and its status follows `decideTokenStatus()`. A system job: it reads
 * connections across workspaces, then writes each row scoped by `workspace_id` + `id`.
 *
 * - Sequential, `TOKEN_CHECK_PAUSE_MS` between calls; on `rate_limited` the run stops calling Meta
 *   (remaining rows are counted `notChecked`) and completes: the next daily run picks them up.
 * - Transient / network / other Graph errors leave the row unchanged (no in-run retry).
 * - A Graph `token_invalid` error (HTTP-level, not `is_valid: false`) is only applied once some
 *   call in the same run succeeded: all calls share the app token, so if none succeeded the app
 *   token itself may be rejected, and flipping every customer to NEEDS_REAUTH would be wrong.
 * - Logs ids, statuses, reasons and scope names only; never a token.
 */
@Injectable()
export class MetaTokenCheckService {
  private readonly logger = new Logger('MetaTokenCheck');
  /** Pause between Graph calls; tests set 0. */
  pauseMs = TOKEN_CHECK_PAUSE_MS;
  pageSize = TOKEN_CHECK_PAGE_SIZE;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly graph: MetaGraphClient,
    private readonly cipher: TokenCipherService,
  ) {}

  async run(now: () => Date = () => new Date()): Promise<TokenCheckOutcome> {
    if (!this.graph.enabled) {
      this.logger.warn('Token check skipped: the Meta app is not configured');
      return { kind: 'token_check_skipped', reason: 'meta_not_configured' };
    }
    if (!this.cipher.isConfigured) {
      this.logger.warn(
        'Token check skipped: the token cipher is not configured',
      );
      return { kind: 'token_check_skipped', reason: 'cipher_not_configured' };
    }
    const counts = emptyCounts();
    const deferred: Pending[] = [];
    let appTokenProven = false;
    let rateLimited = false;
    let calls = 0;
    let afterId: string | null = null;

    for (;;) {
      const rows = await listConnectionsForTokenCheck(
        this.db,
        afterId,
        this.pageSize,
      );
      for (const row of rows) {
        afterId = row.id;
        if (rateLimited) {
          counts.notChecked++;
          continue;
        }
        let token: string;
        try {
          token = this.cipher.decrypt(
            row.encryptedUserAccessToken,
            tokenCipherContext(
              'meta_user_token',
              row.workspaceId,
              row.facebookUserId,
            ),
          );
        } catch {
          counts.undecryptable++;
          this.logger.warn(
            `Connection ${row.id} (workspace ${row.workspaceId}): user token cannot be decrypted; left unchanged`,
          );
          continue;
        }
        if (calls > 0 && this.pauseMs > 0) await sleep(this.pauseMs);
        calls++;
        counts.checked++;
        const outcome = await this.debug(token);
        if (outcome.kind === 'result') appTokenProven = true;
        const verdict = decideTokenStatus(outcome);
        if (verdict.action === 'leave') {
          counts.graphErrors++;
          if (verdict.stop) {
            rateLimited = true;
            this.logger.warn(
              'Token check: Meta rate limit reached; the remaining connections wait for the next run',
            );
          }
          continue;
        }
        if (verdict.reason === 'graph_token_invalid' && !appTokenProven) {
          deferred.push({ row, verdict });
          continue;
        }
        await this.apply(row, verdict, counts, now());
      }
      if (rows.length < this.pageSize) break;
    }

    if (deferred.length > 0) {
      if (appTokenProven) {
        for (const { row, verdict } of deferred) {
          await this.apply(row, verdict, counts, now());
        }
      } else {
        counts.graphErrors += deferred.length;
        this.logger.warn(
          `Token check: ${deferred.length} connection(s) got Graph token errors and no call succeeded; the app access token may be rejected, statuses left unchanged`,
        );
      }
    }
    return { kind: 'token_check', counts, rateLimited };
  }

  private async debug(token: string): Promise<DebugTokenOutcome> {
    try {
      return { kind: 'result', info: await this.graph.debugToken(token) };
    } catch (error) {
      if (error instanceof MetaGraphError) {
        return { kind: 'error', error: error.kind };
      }
      throw error;
    }
  }

  private async apply(
    row: TokenCheckRow,
    verdict: Pending['verdict'],
    counts: TokenCheckCounts,
    now: Date,
  ): Promise<void> {
    const statusChange = verdict.status !== row.status;
    const expiryChange =
      verdict.tokenExpiresAt !== undefined &&
      !sameInstant(verdict.tokenExpiresAt, row.tokenExpiresAt);
    if (!statusChange && !expiryChange) {
      counts.unchanged++;
      return;
    }
    const changed = await applyTokenCheckResult(this.db, {
      workspaceId: row.workspaceId,
      connectionId: row.id,
      observedStatus: row.status,
      observedToken: row.encryptedUserAccessToken,
      status: verdict.status,
      tokenExpiresAt: verdict.tokenExpiresAt,
      now,
    });
    if (!changed) {
      counts.raced++;
      this.logger.debug(
        `Connection ${row.id} changed during the check; verdict dropped`,
      );
      return;
    }
    if (!statusChange) {
      counts.expiryRefreshed++;
      return;
    }
    if (verdict.status === 'ACTIVE') counts.toActive++;
    else counts.toNeedsReauth++;
    const scopes =
      verdict.missingScopes.length > 0
        ? `: ${verdict.missingScopes.join(',')}`
        : '';
    this.logger.log(
      `Connection ${row.id} (workspace ${row.workspaceId}): ${row.status} → ${verdict.status} (${verdict.reason}${scopes})`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
