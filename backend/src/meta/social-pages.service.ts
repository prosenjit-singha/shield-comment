import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { Database } from '../db/database.js';
import {
  PAGE_TOGGLE_ERROR_CODES,
  type TogglePageResponse,
  type WorkspacePageLimit,
  type WorkspacePagesResponse,
} from './dto/workspace-pages.dto.js';
import {
  countActivePages,
  findPlanFeatureConfig,
  findWorkspacePage,
  findWorkspacePlanId,
  listWorkspacePages,
  type PagesExecutor,
  setPageActive,
} from './social-pages.queries.js';

/**
 * `connectedPages` from a plan's raw `feature_config` (D10). A missing plan row (e.g. no Free
 * plan seeded) or a malformed value gives 0: activation fails closed rather than unlimited.
 */
export function connectedPagesLimit(featureConfig: unknown): number {
  if (featureConfig === undefined || featureConfig === null) return 0;
  return normalizeFeatureConfig(featureConfig).limits.connectedPages;
}

/** 409 when one more active Page would exceed the limit (an over-limit workspace can only switch off). */
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
 * Workspace pages API (M3-T6; user decisions D3/D5/D7/D10 2026-11-18). The caller (controller)
 * has already passed `WorkspaceAccessGuard` + `@Roles('owner','admin')`, so `workspaceId` is a
 * workspace the session may manage. Toggling only flips `is_active`: no Meta call (D3,
 * `subscribed_apps` is Module 4) and no disconnect (D7, later).
 */
@Injectable()
export class SocialPagesService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** The workspace's Pages (no tokens) + its `connectedPages` limit and active count. */
  async list(workspaceId: string): Promise<WorkspacePagesResponse> {
    const [items, limit] = await Promise.all([
      listWorkspacePages(this.db, workspaceId),
      this.pageLimit(this.db, workspaceId),
    ]);
    return {
      items,
      pageLimit: {
        limit,
        activeCount: items.filter((page) => page.isActive).length,
      },
    };
  }

  /**
   * Switches moderation on/off for one Page of the workspace. In one transaction:
   * 1. `FOR NO KEY UPDATE` on the workspace row: toggles of one workspace run one at a time, so
   *    two concurrent activations can't both see "limit not reached" (lock order is always
   *    workspace → page, so no deadlock between toggles);
   * 2. `FOR UPDATE` on the Page row, scoped by `workspace_id` + `id` (another workspace's id → 404);
   * 3. same value → no-op (`changed: false`, no UPDATE, `updated_at` kept);
   * 4. activating: no stored token → 409 `PAGE_TOKEN_MISSING`; active count ≥ plan limit → 409
   *    `PAGE_LIMIT_REACHED` with `details { limit, activeCount }`. Deactivating is always allowed.
   */
  async toggle(
    workspaceId: string,
    id: string,
    isActive: boolean,
  ): Promise<TogglePageResponse> {
    return this.db.transaction(async (tx) => {
      const workspace = await findWorkspacePlanId(tx, workspaceId, true);
      if (!workspace) throw pageNotFound();
      const page = await findWorkspacePage(tx, workspaceId, id, true);
      if (!page) throw pageNotFound();
      if (page.isActive === isActive) return { page, changed: false };

      if (isActive) {
        if (!page.hasToken) {
          throw new ConflictException({
            message:
              'This page is no longer connected. Reconnect Facebook to switch it on.',
            error: 'Conflict',
            code: PAGE_TOGGLE_ERROR_CODES.tokenMissing,
          });
        }
        // Sequential: one transaction = one pg client (no concurrent queries on it).
        const limit = connectedPagesLimit(
          await findPlanFeatureConfig(tx, workspace.planId),
        );
        const activeCount = await countActivePages(tx, workspaceId);
        assertCanActivate({ limit, activeCount });
      }

      const updated = await setPageActive(tx, workspaceId, id, isActive);
      if (!updated) throw pageNotFound();
      return { page: updated, changed: true };
    });
  }

  /** `connectedPages` of the workspace's plan, or of the Free plan when it has none (D10). */
  private async pageLimit(
    executor: PagesExecutor,
    workspaceId: string,
  ): Promise<number> {
    const workspace = await findWorkspacePlanId(executor, workspaceId);
    return connectedPagesLimit(
      await findPlanFeatureConfig(executor, workspace?.planId ?? null),
    );
  }
}
