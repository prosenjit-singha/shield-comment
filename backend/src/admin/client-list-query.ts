import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { users, workspaceMembers, workspaces } from '../db/schema/index.js';
import type {
  ClientSort,
  WorkspaceStatus,
} from './dto/list-clients-query.dto.js';

export interface ClientListFilters {
  q?: string;
  status?: WorkspaceStatus;
  createdFrom?: string;
  createdTo?: string;
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
 * the workspace name or slug, or the email or name of **any** owner of the workspace.
 */
export function clientListWhere(
  db: Database,
  filters: ClientListFilters,
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
