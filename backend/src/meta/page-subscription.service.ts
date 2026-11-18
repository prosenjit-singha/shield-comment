import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import { MetaGraphClient } from './meta-graph.client.js';
import {
  MetaGraphError,
  type MetaGraphErrorKind,
} from './meta-graph.errors.js';
import {
  findWorkspacePageToken,
  markConnectionNeedsReauth,
  type PageTokenRow,
} from './page-subscription.queries.js';

/** A Page row that has a token ciphertext. */
export type PageWithToken = PageTokenRow & { encryptedPageAccessToken: string };

export type PageSubscribeResult =
  | { kind: 'subscribed' }
  /** The stored ciphertext can't be decrypted with this row's context / keyring: reconnect. */
  | { kind: 'undecryptable' }
  /**
   * Graph refused or failed. `connectionMarked` = this failure moved the workspace connection
   * `ACTIVE` → `NEEDS_REAUTH` (only for `token_invalid`).
   */
  | {
      kind: 'graph_failed';
      errorKind: MetaGraphErrorKind;
      connectionMarked: boolean;
    };

/**
 * `subscribed_apps` for one Page (M4-T8, Module 4 D2/D10): decrypt the Page token, call Graph,
 * and on `token_invalid` mark the workspace connection NEEDS_REAUTH. Used by the Page toggle and
 * the one-off backfill script. Logs ids, error kinds and codes only (never tokens or messages).
 */
@Injectable()
export class PageSubscriptionService {
  private readonly logger = new Logger(PageSubscriptionService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly graph: MetaGraphClient,
    private readonly cipher: TokenCipherService,
  ) {}

  /** Both the Meta app and the token cipher are configured. */
  get configured(): boolean {
    return this.graph.enabled && this.cipher.isConfigured;
  }

  /** Never throws for Graph or decrypt failures (they are results); DB errors propagate. */
  async subscribe(
    page: PageWithToken,
    now: () => Date = () => new Date(),
  ): Promise<PageSubscribeResult> {
    const token = this.decrypt(page);
    if (token === null) return { kind: 'undecryptable' };
    try {
      await this.graph.subscribePageApp(page.pageId, token);
      return { kind: 'subscribed' };
    } catch (error) {
      if (!(error instanceof MetaGraphError)) throw error;
      const connectionMarked = await this.onGraphError(
        'subscribe',
        page,
        error,
        now,
      );
      return { kind: 'graph_failed', errorKind: error.kind, connectionMarked };
    }
  }

  /**
   * Best-effort `DELETE /{page-id}/subscribed_apps` (switch-off, or undoing a subscribe whose
   * toggle transaction then refused). Re-reads the Page (scoped by `workspace_id`) and skips it
   * when it is gone, active again, has no token, or Meta/cipher is unset. Never throws: failures
   * are logged with ids only. `true` = Graph confirmed the unsubscribe.
   */
  async unsubscribeBestEffort(
    workspaceId: string,
    pageRowId: string,
    now: () => Date = () => new Date(),
  ): Promise<boolean> {
    try {
      if (!this.configured) return false;
      const page = await findWorkspacePageToken(
        this.db,
        workspaceId,
        pageRowId,
      );
      if (!page || page.isActive || page.encryptedPageAccessToken === null) {
        return false;
      }
      const withToken: PageWithToken = {
        ...page,
        encryptedPageAccessToken: page.encryptedPageAccessToken,
      };
      const token = this.decrypt(withToken);
      if (token === null) return false;
      try {
        await this.graph.unsubscribePageApp(page.pageId, token);
        return true;
      } catch (error) {
        if (!(error instanceof MetaGraphError)) throw error;
        await this.onGraphError('unsubscribe', withToken, error, now);
        return false;
      }
    } catch (error) {
      this.logger.warn(
        `Page ${pageRowId} (workspace ${workspaceId}): unsubscribe skipped after an error (${error instanceof Error ? error.name : 'unknown'})`,
      );
      return false;
    }
  }

  private decrypt(page: PageWithToken): string | null {
    try {
      return this.cipher.decrypt(
        page.encryptedPageAccessToken,
        tokenCipherContext('meta_page_token', page.workspaceId, page.pageId),
      );
    } catch {
      this.logger.warn(
        `Page ${page.id} (workspace ${page.workspaceId}): Page token cannot be decrypted`,
      );
      return null;
    }
  }

  /** Logs the failure; `token_invalid` → connection NEEDS_REAUTH (D10). `true` = it changed. */
  private async onGraphError(
    action: 'subscribe' | 'unsubscribe',
    page: PageWithToken,
    error: MetaGraphError,
    now: () => Date,
  ): Promise<boolean> {
    this.logger.warn(
      `Page ${page.id} (workspace ${page.workspaceId}): ${action} failed (${error.kind}${error.code === undefined ? '' : ` #${error.code}`})`,
    );
    if (error.kind !== 'token_invalid') return false;
    const marked = await markConnectionNeedsReauth(this.db, {
      workspaceId: page.workspaceId,
      pageRowId: page.id,
      observedPageToken: page.encryptedPageAccessToken,
      now: now(),
    });
    if (marked) {
      this.logger.warn(
        `Workspace ${page.workspaceId}: Meta connection ACTIVE → NEEDS_REAUTH (Page token rejected)`,
      );
    }
    return marked;
  }
}
