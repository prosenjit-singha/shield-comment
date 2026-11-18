import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { plans, socialPages, workspaces } from '../db/schema/index.js';
import type { WorkspacePage } from './dto/workspace-pages.dto.js';

/**
 * Queries behind the workspace pages API (M3-T6). Every `social_pages` query is scoped by
 * `workspace_id`; none ever selects a token column (only `hasToken`).
 */

/** A database or a transaction. */
export type PagesExecutor = Pick<Database, 'select' | 'update'>;

/** Slug of the plan whose limits apply to a workspace without a plan (D10). */
export const FALLBACK_PLAN_SLUG = 'free';

const pageColumns = {
  id: socialPages.id,
  pageId: socialPages.pageId,
  pageName: socialPages.pageName,
  igBusinessId: socialPages.igBusinessId,
  igUsername: socialPages.igUsername,
  isActive: socialPages.isActive,
  hasToken: sql<boolean>`${socialPages.encryptedPageAccessToken} is not null`,
  createdAt: socialPages.createdAt,
  updatedAt: socialPages.updatedAt,
};

/** The workspace's Pages, sorted by name then Page id (stable). */
export function listWorkspacePages(
  executor: PagesExecutor,
  workspaceId: string,
): Promise<WorkspacePage[]> {
  return executor
    .select(pageColumns)
    .from(socialPages)
    .where(eq(socialPages.workspaceId, workspaceId))
    .orderBy(asc(socialPages.pageName), asc(socialPages.pageId));
}

/**
 * One Page of the workspace (`undefined` when the id belongs to no Page of **this** workspace).
 * `lock` = `SELECT … FOR UPDATE` on the row (inside a transaction).
 */
export async function findWorkspacePage(
  executor: PagesExecutor,
  workspaceId: string,
  id: string,
  lock = false,
): Promise<WorkspacePage | undefined> {
  const query = executor
    .select(pageColumns)
    .from(socialPages)
    .where(
      and(eq(socialPages.workspaceId, workspaceId), eq(socialPages.id, id)),
    );
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * The workspace's `plan_id` (`null` = no plan). `lock` takes `FOR NO KEY UPDATE` on the
 * workspace row: it serialises the workspace's page toggles (so two activations can't both pass
 * the limit) without blocking FK checks of rows that reference the workspace.
 * `undefined` = no such workspace.
 */
export async function findWorkspacePlanId(
  executor: PagesExecutor,
  workspaceId: string,
  lock = false,
): Promise<{ planId: string | null } | undefined> {
  const query = executor
    .select({ planId: workspaces.planId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const [row] = await (lock ? query.for('no key update') : query);
  return row;
}

/** Raw `feature_config` of the plan, or of the Free plan when `planId` is `null`. */
export async function findPlanFeatureConfig(
  executor: PagesExecutor,
  planId: string | null,
): Promise<unknown> {
  const [row] = await executor
    .select({ featureConfig: plans.featureConfig })
    .from(plans)
    .where(
      planId === null
        ? eq(plans.slug, FALLBACK_PLAN_SLUG)
        : eq(plans.id, planId),
    )
    .limit(1);
  return row?.featureConfig;
}

/** Active Pages of the workspace. */
export async function countActivePages(
  executor: PagesExecutor,
  workspaceId: string,
): Promise<number> {
  const [row] = await executor
    .select({ value: count() })
    .from(socialPages)
    .where(
      and(
        eq(socialPages.workspaceId, workspaceId),
        eq(socialPages.isActive, true),
      ),
    );
  return row?.value ?? 0;
}

/** Sets `is_active` on one Page of the workspace and returns it (`updated_at` moves). */
export async function setPageActive(
  executor: PagesExecutor,
  workspaceId: string,
  id: string,
  isActive: boolean,
): Promise<WorkspacePage | undefined> {
  const [row] = await executor
    .update(socialPages)
    .set({ isActive })
    .where(
      and(eq(socialPages.workspaceId, workspaceId), eq(socialPages.id, id)),
    )
    .returning(pageColumns);
  return row;
}
