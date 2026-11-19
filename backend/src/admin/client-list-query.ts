import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  lt,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  subscriptions,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema/index.js';
import { isLiveAt } from '../wallet/live-subscription.queries.js';
import type {
  ClientSort,
  WorkspaceStatus,
} from './dto/list-clients-query.dto.js';

export interface ClientListFilters {
  q?: string;
  status?: WorkspaceStatus;
  createdFrom?: string;
  createdTo?: string;
  /**
   * Resolved plan filter (M2-T12b; live subscription since PW-T6b): a plan id = the workspace's
   * billing account has a live subscription on that plan; `null` = no live plan (no account,
   * ended or never subscribed). `undefined` = any. The service turns the `plan` slug (or `none`)
   * into this.
   */
  planId?: string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `%`, `_` and `\` match literally (backslash is Postgres' default LIKE escape). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * The created-at range as `[from, before)`. Both query bounds are inclusive: a date-only
 * `createdTo` covers its whole UTC day, a date-time one its exact millisecond (columns are
 * `timestamptz(3)`). Values were validated by `ListClientsQueryDto`.
 */
export function createdRange(
  createdFrom?: string,
  createdTo?: string,
): { from?: Date; before?: Date } {
  const from = createdFrom ? new Date(createdFrom) : undefined;
  let before: Date | undefined;
  if (createdTo) {
    const to = new Date(createdTo);
    before = new Date(to.getTime() + (DATE_ONLY.test(createdTo) ? DAY_MS : 1));
  }
  return { from, before };
}

/**
 * WHERE for the super admin client list (M2-T3). `q` matches, case-insensitively and partially,
 * the workspace name or slug, or the email or name of **any** owner of the workspace. The plan
 * filter reads the live subscription at `now` (PW-T6b, same rule as `findLiveSubscription`).
 */
export function clientListWhere(
  db: Database,
  filters: ClientListFilters,
  now: Date = new Date(),
): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    const ownerMatches = db
      .select({ one: sql`1` })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.role, 'owner'),
          or(ilike(users.email, pattern), ilike(users.name, pattern)),
        ),
      );
    conditions.push(
      or(
        ilike(workspaces.name, pattern),
        ilike(workspaces.slug, pattern),
        exists(ownerMatches),
      )!,
    );
  }
  if (filters.status) conditions.push(eq(workspaces.status, filters.status));
  if (filters.planId !== undefined) {
    const live = db
      .select({ one: sql`1` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.billingAccountId, workspaces.billingAccountId),
          isLiveAt(now),
          filters.planId === null
            ? undefined
            : eq(subscriptions.planId, filters.planId),
        ),
      );
    conditions.push(filters.planId === null ? not(exists(live)) : exists(live));
  }
  const { from, before } = createdRange(filters.createdFrom, filters.createdTo);
  if (from) conditions.push(gte(workspaces.createdAt, from));
  if (before) conditions.push(lt(workspaces.createdAt, before));
  return conditions.length ? and(...conditions) : undefined;
}

/** ORDER BY for each sort, with `id` as a stable tiebreaker. Name sort ignores case. */
export function clientListOrder(sort: ClientSort): SQL[] {
  switch (sort) {
    case 'oldest':
      return [asc(workspaces.createdAt), asc(workspaces.id)];
    case 'name':
      return [asc(sql`lower(${workspaces.name})`), asc(workspaces.id)];
    case 'newest':
      return [desc(workspaces.createdAt), desc(workspaces.id)];
  }
}
