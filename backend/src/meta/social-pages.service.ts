import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../db/database.js';
import {
  findLiveSubscription,
  type LiveSubscription,
} from '../wallet/live-subscription.queries.js';
import {
  PAGE_TOGGLE_ERROR_CODES,
  type TogglePageResponse,
  type WorkspaceMetaConnection,
  type WorkspacePageLimit,
  type WorkspacePagesResponse,
} from './dto/workspace-pages.dto.js';
import { findWorkspacePageToken } from './page-subscription.queries.js';
import { PageSubscriptionService } from './page-subscription.service.js';
import {
  countPooledActivePages,
  findWorkspaceBilling,
  findWorkspaceConnection,
  findWorkspacePage,
  listWorkspacePages,
  lockBillingAccount,
  type PagesExecutor,
  setPageActive,
} from './social-pages.queries.js';

/**
 * `limits.connectedPages` of the live plan (PW-T5: pooled per billing account, PW-D11). No live
 * plan = 0 (PW-D7: no Free fallback); the plan's config is already normalised (a malformed value
 * is 0, so activation fails closed rather than unlimited).
 */
export function connectedPagesLimit(
  live: Pick<LiveSubscription, 'plan'> | null,
): number {
  return live?.plan.featureConfig.limits.connectedPages ?? 0;
}

/**
 * 409 `NO_ACTIVE_PLAN` (PW-T5, PW-D9 + the confirmed PW-PLAN reading) when the workspace's account
 * has no live plan (no account, trial/term over): switching **on** is refused, off always works.
 */
export function assertLivePlan(
  live: LiveSubscription | null,
): asserts live is LiveSubscription {
  if (!live) throw noActivePlan();
}

const noActivePlan = () =>
  new ConflictException({
    message:
      'Your plan has ended, so pages can’t be switched on. Choose a plan to turn protection back on.',
    error: 'Conflict',
    code: PAGE_TOGGLE_ERROR_CODES.noActivePlan,
  });

/**
 * 409 when one more active Page would exceed the limit (an over-limit account can only switch
 * off). `activeCount` is pooled across the account's workspaces (PW-T5).
 */
export function assertCanActivate(usage: WorkspacePageLimit): void {
  if (usage.activeCount >= usage.limit) {
    throw new ConflictException({
      message: `Your plan allows ${usage.limit} active page${usage.limit === 1 ? '' : 's'} and ${usage.activeCount} ${usage.activeCount === 1 ? 'is' : 'are'} on. Switch one off or upgrade your plan.`,
      error: 'Conflict',
      code: PAGE_TOGGLE_ERROR_CODES.limitReached,
      details: { limit: usage.limit, activeCount: usage.activeCount },
    });
  }
}

const pageNotFound = () => new NotFoundException('Page not found');

/**
 * 409 `CONNECTION_NEEDS_REAUTH` (M4-T9, D9 soft block) unless the connection is `ACTIVE`.
 * `REVOKED` and "no connection" are refused the same way: all three need a Facebook reconnect.
 */
export function assertConnectionActive(
  connection: Pick<WorkspaceMetaConnection, 'status'> | undefined,
): void {
  if (connection?.status === 'ACTIVE') return;
  throw new ConflictException({
    message:
      'Facebook needs to be reconnected before a page can be switched on. Reconnect Facebook and try again.',
    error: 'Conflict',
    code: PAGE_TOGGLE_ERROR_CODES.connectionNeedsReauth,
  });
}

const tokenMissing = () =>
  new ConflictException({
    message:
      'This page is no longer connected. Reconnect Facebook to switch it on.',
    error: 'Conflict',
    code: PAGE_TOGGLE_ERROR_CODES.tokenMissing,
  });

/**
 * Workspace pages API (M3-T6; user decisions D3/D5/D7/D10 2026-11-18). The caller (controller)
 * has already passed `WorkspaceAccessGuard` + `@Roles('owner','admin')`, so `workspaceId` is a
 * workspace the session may manage. Switching a Page on installs the app on it with Graph
 * `subscribed_apps` first (M4-T8, Module 4 D10); switching off removes it best effort.
 */
@Injectable()
export class SocialPagesService {
  private readonly logger = new Logger(SocialPagesService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly subscriptions: PageSubscriptionService,
  ) {}

  /**
   * The workspace's Pages (no tokens) + the account's pooled `connectedPages` usage (PW-T5:
   * `limit` of the live plan, 0 without one; `activeCount` across all the account's workspaces) +
   * the Meta connection status (M4-T9, D9; `null` = not connected).
   */
  async list(workspaceId: string): Promise<WorkspacePagesResponse> {
    const [items, usage, connection] = await Promise.all([
      listWorkspacePages(this.db, workspaceId),
      this.pageUsage(this.db, workspaceId),
      findWorkspaceConnection(this.db, workspaceId),
    ]);
    return {
      items,
      pageLimit: {
        limit: connectedPagesLimit(usage.live),
        activeCount: usage.activeCount,
      },
      connection: connection ?? null,
    };
  }

  /**
   * Switches moderation on/off for one Page of the workspace.
   *
   * **On** (M4-T8, D10): pre-checks that need no Graph call (Page of this workspace, already on =
   * no-op without Graph, connection `ACTIVE` (M4-T9, D9: else 409 `CONNECTION_NEEDS_REAUTH`), has
   * a token, a live plan (PW-T5: else 409 `NO_ACTIVE_PLAN`), under the account's pooled limit),
   * Meta + cipher configured (else 503),
   * decrypt the Page token, `POST /{page-id}/subscribed_apps` **outside** any transaction. Graph
   * failure → 502 `META_SUBSCRIBE_FAILED`, nothing written (a `token_invalid` also marks the
   * connection NEEDS_REAUTH); an undecryptable token → 409 `PAGE_TOKEN_MISSING` (reconnect). Then
   * the transaction re-checks everything under locks; if it refuses (limit raced, Page gone…) the
   * subscribe is undone best effort.
   *
   * **Off**: the transaction always switches off, then (after commit) a best-effort
   * `DELETE /{page-id}/subscribed_apps`; its failure never changes the response.
   */
  async toggle(
    workspaceId: string,
    id: string,
    isActive: boolean,
  ): Promise<TogglePageResponse> {
    if (!isActive) {
      const result = await this.toggleInTx(workspaceId, id, false);
      if (result.changed) {
        await this.subscriptions.unsubscribeBestEffort(workspaceId, id);
      }
      return result;
    }

    const current = await findWorkspacePage(this.db, workspaceId, id);
    if (!current) throw pageNotFound();
    if (current.isActive) return { page: current, changed: false };
    assertConnectionActive(await findWorkspaceConnection(this.db, workspaceId));
    if (!current.hasToken) throw tokenMissing();
    const usage = await this.pageUsage(this.db, workspaceId);
    assertLivePlan(usage.live);
    assertCanActivate({
      limit: connectedPagesLimit(usage.live),
      activeCount: usage.activeCount,
    });
    if (!this.subscriptions.configured) {
      throw new ServiceUnavailableException(
        'Meta connection is not configured on this server',
      );
    }
    const page = await findWorkspacePageToken(this.db, workspaceId, id);
    if (!page) throw pageNotFound();
    if (page.encryptedPageAccessToken === null) throw tokenMissing();
    const subscribed = await this.subscriptions.subscribe({
      ...page,
      encryptedPageAccessToken: page.encryptedPageAccessToken,
    });
    if (subscribed.kind === 'undecryptable') throw tokenMissing();
    if (subscribed.kind === 'graph_failed') {
      throw new BadGatewayException({
        message:
          'Facebook did not confirm the webhook subscription for this Page, so protection stays off. Try again.',
        error: 'Bad Gateway',
        code: PAGE_TOGGLE_ERROR_CODES.subscribeFailed,
      });
    }

    try {
      return await this.toggleInTx(workspaceId, id, true);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        // Refused under the locks after a successful subscribe: undo it (skipped if the Page is
        // gone or was switched on meanwhile).
        this.logger.warn(
          `Page ${id} (workspace ${workspaceId}): switch-on refused after subscribe (${error.getStatus()}); unsubscribing`,
        );
        await this.subscriptions.unsubscribeBestEffort(workspaceId, id);
      }
      throw error;
    }
  }

  /**
   * The M3-T6 transaction:
   * 1. `FOR NO KEY UPDATE` on the workspace row: toggles of one workspace run one at a time, so
   *    two concurrent activations can't both see "limit not reached" (lock order is always
   *    workspace → page, so no deadlock between toggles);
   * 2. `FOR UPDATE` on the Page row, scoped by `workspace_id` + `id` (another workspace's id → 404);
   * 3. same value → no-op (`changed: false`, no UPDATE, `updated_at` kept);
   * 4. activating: connection not `ACTIVE` (read under the workspace lock) → 409
   *    `CONNECTION_NEEDS_REAUTH` (M4-T9); no stored token → 409 `PAGE_TOKEN_MISSING`; no billing
   *    account or no live plan → 409 `NO_ACTIVE_PLAN` (PW-T5); else `FOR NO KEY UPDATE` on the
   *    billing account row (activations of all its workspaces serialise) and the pooled active
   *    count ≥ the plan limit → 409 `PAGE_LIMIT_REACHED` with `details { limit, activeCount }`.
   *    Deactivating is always allowed (also while NEEDS_REAUTH/REVOKED or without a plan).
   */
  private toggleInTx(
    workspaceId: string,
    id: string,
    isActive: boolean,
  ): Promise<TogglePageResponse> {
    return this.db.transaction(async (tx) => {
      const workspace = await findWorkspaceBilling(tx, workspaceId, true);
      if (!workspace) throw pageNotFound();
      const page = await findWorkspacePage(tx, workspaceId, id, true);
      if (!page) throw pageNotFound();
      if (page.isActive === isActive) return { page, changed: false };

      if (isActive) {
        assertConnectionActive(await findWorkspaceConnection(tx, workspaceId));
        if (!page.hasToken) throw tokenMissing();
        // Sequential: one transaction = one pg client (no concurrent queries on it).
        if (
          workspace.billingAccountId === null ||
          !(await lockBillingAccount(tx, workspace.billingAccountId))
        ) {
          throw noActivePlan();
        }
        const live = await findLiveSubscription(tx, workspaceId);
        assertLivePlan(live);
        assertCanActivate({
          limit: connectedPagesLimit(live),
          activeCount: await countPooledActivePages(tx, workspaceId),
        });
      }

      const updated = await setPageActive(tx, workspaceId, id, isActive);
      if (!updated) throw pageNotFound();
      return { page: updated, changed: true };
    });
  }

  /** The workspace's live plan + the account's pooled active Page count (no locks). */
  private async pageUsage(
    executor: PagesExecutor,
    workspaceId: string,
  ): Promise<{ live: LiveSubscription | null; activeCount: number }> {
    const [live, activeCount] = await Promise.all([
      findLiveSubscription(executor, workspaceId),
      countPooledActivePages(executor, workspaceId),
    ]);
    return { live, activeCount };
  }
}
