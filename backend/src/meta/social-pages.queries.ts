import { and, asc, count, eq, or, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  billingAccounts,
  metaConnections,
  socialPages,
  workspaces,
} from '../db/schema/index.js';
import type {
  WorkspaceMetaConnection,
  WorkspacePage,
} from './dto/workspace-pages.dto.js';

/**
 * Queries behind the workspace pages API (M3-T6; pooled per billing account since PW-T5). Every
 * `social_pages` query is scoped by `workspace_id` (the pooled count by the workspace's own
 * `billing_account_id`); none ever selects a token column (only `hasToken`).
 */

/** A database or a transaction. */
export type PagesExecutor = Pick<Database, 'select' | 'update'>;

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
 * The workspace's `billing_account_id` (`null` = no account, so no live plan). `lock` takes
 * `FOR NO KEY UPDATE` on the workspace row: it serialises the workspace's page toggles (and Meta
 * disconnect) without blocking FK checks of rows that reference the workspace.
 * `undefined` = no such workspace.
 */
export async function findWorkspaceBilling(
  executor: PagesExecutor,
  workspaceId: string,
  lock = false,
): Promise<{ billingAccountId: string | null } | undefined> {
  const query = executor
    .select({ billingAccountId: workspaces.billingAccountId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const [row] = await (lock ? query.for('no key update') : query);
  return row;
}

/**
 * `FOR NO KEY UPDATE` on the billing account row (PW-T5, PW-D11): Page activations of **all** the
 * account's workspaces run one at a time, so two workspaces can't both pass the pooled limit.
 * Taken after the workspace lock (lock order workspace → account → page). `false` = no such row.
 */
export async function lockBillingAccount(
  executor: PagesExecutor,
  billingAccountId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(eq(billingAccounts.id, billingAccountId))
    .for('no key update');
  return row !== undefined;
}

/**
 * The workspace's Meta connection status (M4-T9, D9): no token, no Facebook user id.
 * `undefined` = no connection row.
 */
export async function findWorkspaceConnection(
  executor: PagesExecutor,
  workspaceId: string,
): Promise<WorkspaceMetaConnection | undefined> {
  const [row] = await executor
    .select({
      status: metaConnections.status,
      statusChangedAt: metaConnections.statusChangedAt,
      tokenExpiresAt: metaConnections.tokenExpiresAt,
    })
    .from(metaConnections)
    .where(eq(metaConnections.workspaceId, workspaceId));
  return row;
}

/**
 * Active Pages pooled across the workspace's billing account (PW-D11): every workspace with the
 * same `billing_account_id`, or only this workspace when it has no account. One query; the
 * account comes from the workspace row itself, so another tenant's Pages are never counted.
 */
export async function countPooledActivePages(
  executor: PagesExecutor,
  workspaceId: string,
): Promise<number> {
  const accountOfWorkspace = executor
    .select({ id: workspaces.billingAccountId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const [row] = await executor
    .select({ value: count() })
    .from(socialPages)
    .innerJoin(workspaces, eq(workspaces.id, socialPages.workspaceId))
    .where(
      and(
        eq(socialPages.isActive, true),
        or(
          eq(socialPages.workspaceId, workspaceId),
          eq(workspaces.billingAccountId, accountOfWorkspace),
        ),
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
