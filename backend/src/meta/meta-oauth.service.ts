import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import { findWorkspaceMembership } from '../auth/authz-queries.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  TokenCipherNotConfiguredError,
  TokenCipherService,
  tokenCipherContext,
} from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import { upsertMetaConnection } from './meta-connection.queries.js';
import { MetaGraphClient } from './meta-graph.client.js';
import { MetaGraphError, MetaNotConfiguredError } from './meta-graph.errors.js';
import {
  DEFAULT_META_OAUTH_RETURN_PATH,
  generateMetaOAuthState,
  isWellFormedMetaOAuthState,
  META_OAUTH_STATE_TTL_SECONDS,
  type MetaOAuthErrorReason,
  type MetaOAuthResult,
  type MetaOAuthReturnPath,
  type MetaOAuthStateData,
  metaOAuthClientRedirect,
} from './meta-oauth-state.js';
import { MetaOAuthStateStore } from './meta-oauth-state.store.js';
import {
  type PageSyncResult,
  type SocialPageSyncInput,
  syncSocialPages,
} from './social-pages.sync.js';

/** Workspace roles that may connect Meta (D5). */
const CONNECT_ROLES = new Set(['owner', 'admin']);

/** Query Meta appends to the redirect URI. Only these keys are read; values may be arrays. */
export type MetaOAuthCallbackQuery = Record<string, unknown>;

class CallbackFailure extends Error {
  constructor(readonly reason: MetaOAuthErrorReason) {
    super(reason);
  }
}

function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const sqlState = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  return `${error.name}${sqlState}`;
}

function fail(reason: MetaOAuthErrorReason): never {
  throw new CallbackFailure(reason);
}

/**
 * Meta OAuth connect flow (M3-T4; user decisions D5/D6 2026-11-18).
 * - `createLoginUrl`: owner/admin of the session's active workspace, not impersonated → state in
 *   Redis (10 min, single use) + the Login for Business dialog URL.
 * - `handleCallback`: never throws; always returns the client URL to redirect to
 *   (`<CLIENT_APP_URL><returnTo>?meta=connected|error&reason=…`). On success the workspace's
 *   `meta_connections` row holds the encrypted long-lived user token, and `social_pages` holds the
 *   user's Pages (M3-T5: new ones inactive, encrypted Page tokens, other workspaces' Pages skipped
 *   → `&skipped=N`), both written in one transaction.
 * Tokens and OAuth codes are never logged or returned.
 */
@Injectable()
export class MetaOAuthService implements OnModuleInit {
  private readonly logger = new Logger(MetaOAuthService.name);
  private readonly clientOrigin: string;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly graph: MetaGraphClient,
    private readonly cipher: TokenCipherService,
    private readonly states: MetaOAuthStateStore,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.clientOrigin =
      config.get('CLIENT_APP_URL', { infer: true }) ?? DEFAULT_CLIENT_APP_URL;
  }

  /** Startup never fails over missing Meta/cipher env; the URL endpoint answers 503 instead. */
  onModuleInit(): void {
    if (this.graph.enabled && !this.cipher.isConfigured) {
      this.logger.warn(
        'Meta app is configured but the token cipher is not (TOKEN_ENCRYPTION_KEY/_KEY_ID): Meta connect returns 503',
      );
    }
  }

  get configured(): boolean {
    return this.graph.enabled && this.cipher.isConfigured;
  }

  async createLoginUrl(
    session: AuthSession,
    workspace: WorkspaceContext,
    returnTo: MetaOAuthReturnPath = DEFAULT_META_OAUTH_RETURN_PATH,
  ): Promise<{ url: string }> {
    if (session.session.impersonatedBy) {
      // D5: an admin's own Facebook account must never be linked to a client.
      throw new ForbiddenException(
        'Connecting Meta is not allowed while impersonating',
      );
    }
    // D6: the callback checks the session's active workspace, so start from it.
    if (session.session.activeOrganizationId?.toLowerCase() !== workspace.id) {
      throw new ConflictException(
        'Switch to this workspace before connecting Meta',
      );
    }
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Meta connection is not configured on this server',
      );
    }
    const state = generateMetaOAuthState();
    await this.states.save(
      state,
      { userId: session.user.id, workspaceId: workspace.id, returnTo },
      META_OAUTH_STATE_TTL_SECONDS,
    );
    return { url: this.graph.buildLoginUrl(state) };
  }

  async handleCallback(
    query: MetaOAuthCallbackQuery,
    session: AuthSession | null,
  ): Promise<string> {
    let returnTo: MetaOAuthReturnPath = DEFAULT_META_OAUTH_RETURN_PATH;
    let result: MetaOAuthResult;
    try {
      const state = await this.takeState(query['state']);
      returnTo = state.returnTo;
      const sync = await this.connect(query, session, state);
      result = { ok: true, skipped: sync.skipped.length };
    } catch (error) {
      result = { ok: false, reason: this.failureReason(error) };
    }
    return metaOAuthClientRedirect(this.clientOrigin, returnTo, result);
  }

  private async takeState(raw: unknown): Promise<MetaOAuthStateData> {
    if (!isWellFormedMetaOAuthState(raw)) return fail('invalid_state');
    // Burned before anything else: a state is good for exactly one callback, success or not.
    return (await this.states.take(raw)) ?? fail('invalid_state');
  }

  private async connect(
    query: MetaOAuthCallbackQuery,
    session: AuthSession | null,
    state: MetaOAuthStateData,
  ): Promise<PageSyncResult> {
    const error = query['error'];
    if (error !== undefined) {
      fail(error === 'access_denied' ? 'access_denied' : 'meta_error');
    }
    if (!session) return fail('unauthenticated');
    if (session.session.impersonatedBy) fail('impersonation_blocked');
    if (
      session.user.id !== state.userId ||
      session.session.activeOrganizationId?.toLowerCase() !== state.workspaceId
    ) {
      fail('state_mismatch');
    }
    // Role/suspension may have changed during the dialog: check again.
    const membership = await findWorkspaceMembership(
      this.db,
      state.workspaceId,
      session.user.id,
    );
    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      !CONNECT_ROLES.has(membership.role)
    ) {
      fail('forbidden');
    }
    const code = query['code'];
    if (typeof code !== 'string' || code.length === 0) fail('missing_code');
    if (!this.configured) fail('not_configured');

    const shortLived = await this.graph.exchangeCode(code);
    const longLived = await this.graph.exchangeForLongLivedToken(
      shortLived.accessToken,
    );
    const me = await this.graph.getMe(longLived.accessToken);
    const permissions = await this.graph.getPermissions(longLived.accessToken);
    // All Meta calls happen before the transaction: a Graph failure writes nothing.
    const pages = await this.graph.getPages(longLived.accessToken);

    const workspaceId = state.workspaceId;
    const encryptedUserAccessToken = this.cipher.encrypt(
      longLived.accessToken,
      tokenCipherContext('meta_user_token', workspaceId, me.id),
    );
    const pageRows: SocialPageSyncInput[] = pages.map((page) => ({
      pageId: page.id,
      pageName: page.name,
      igBusinessId: page.instagram?.id ?? null,
      igUsername: page.instagram?.username ?? null,
      encryptedPageAccessToken: this.cipher.encrypt(
        page.accessToken,
        tokenCipherContext('meta_page_token', workspaceId, page.id),
      ),
    }));

    const { connection, sync } = await this.db.transaction(async (tx) => {
      const connection = await upsertMetaConnection(tx, {
        workspaceId,
        facebookUserId: me.id,
        encryptedUserAccessToken,
        tokenExpiresAt: longLived.expiresAt,
        grantedScopes: [...new Set(permissions.granted)].sort(),
      });
      const sync = await syncSocialPages(tx, workspaceId, pageRows);
      return { connection, sync };
    });
    // Ids + counts only (never names or tokens); skipped Pages name their reason, not the owner.
    const skipped = sync.skipped
      .map((page) => `${page.pageId}:${page.reason}`)
      .join(',');
    this.logger.log(
      `Meta connected: workspace ${workspaceId}, connection ${connection.id}, pages created=${sync.created} updated=${sync.updated} deactivated=${sync.deactivated} skipped=${sync.skipped.length}${skipped ? ` [${skipped}]` : ''}`,
    );
    return sync;
  }

  private failureReason(error: unknown): MetaOAuthErrorReason {
    if (error instanceof CallbackFailure) return error.reason;
    if (
      error instanceof MetaNotConfiguredError ||
      error instanceof TokenCipherNotConfiguredError
    ) {
      return 'not_configured';
    }
    if (error instanceof MetaGraphError) {
      // Messages are already scrubbed of tokens/secrets (M3-T3); log kind + codes only anyway.
      this.logger.warn(
        `Meta OAuth exchange failed: kind=${error.kind} status=${error.status ?? '-'} code=${error.code ?? '-'}`,
      );
      return error.retryable ? 'meta_unavailable' : 'meta_error';
    }
    // Name + SQLSTATE only: driver messages can echo query parameters (the ciphertext, ids).
    this.logger.error(`Meta OAuth callback failed: ${describeFailure(error)}`);
    return 'server_error';
  }
}
