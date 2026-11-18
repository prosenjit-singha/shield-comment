import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  plans,
  users,
  workspaceMembers,
  workspaces,
  workspaceStatusAuditLogs,
} from '../db/schema/index.js';
import {
  type ClientListFilters,
  clientListOrder,
  clientListWhere,
  createdRange,
} from './client-list-query.js';
import {
  type ClientSort,
  NO_PLAN,
  type WorkspaceStatus,
} from './dto/list-clients-query.dto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClientOwner {
  id: string;
  email: string;
  name: string;
}

export interface ClientListQuery extends Omit<ClientListFilters, 'planId'> {
  skip: number;
  take: number;
  sort: ClientSort;
  /** Plan slug, or `none` for workspaces without a plan. */
  plan?: string;
}

/** The workspace's plan (M2-T12b), `null` until one is assigned (Module 8). */
export interface ClientPlan {
  id: string;
  slug: string;
  name: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdAt: Date;
  plan: ClientPlan | null;
}

export interface ClientItem extends WorkspaceRow {
  /** Oldest owner membership, or `null` if the workspace has none. */
  owner: ClientOwner | null;
  memberCount: number;
}

const workspaceColumns = {
  id: workspaces.id,
  name: workspaces.name,
  slug: workspaces.slug,
  status: workspaces.status,
  createdAt: workspaces.createdAt,
  // LEFT JOIN plans: Drizzle returns `null` for the nested object when no plan matched.
  plan: { id: plans.id, slug: plans.slug, name: plans.name },
};

/**
 * Super admin view of every client workspace. Cross-tenant by design (only reachable through
 * `SuperAdminGuard`); the member/owner lookups are still scoped to the page's workspace ids.
 */
@Injectable()
export class AdminClientsService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** `{ items, total, skip, take }`; `total` counts every match of the filters. */
  async list(query: ClientListQuery) {
    const { skip, take, sort } = query;
    const { from, before } = createdRange(query.createdFrom, query.createdTo);
    if (from && before && from.getTime() >= before.getTime()) {
      throw new BadRequestException('createdFrom must not be after createdTo');
    }
    const planId = await this.resolvePlanFilter(query.plan);
    const where = clientListWhere(this.db, { ...query, planId });
    const [page, [totals]] = await Promise.all([
      this.db
        .select(workspaceColumns)
        .from(workspaces)
        .leftJoin(plans, eq(plans.id, workspaces.planId))
        .where(where)
        .orderBy(...clientListOrder(sort))
        .offset(skip)
        .limit(take),
      this.db.select({ total: count() }).from(workspaces).where(where),
    ]);
    return {
      items: await this.withOwnersAndCounts(page),
      total: totals?.total ?? 0,
      skip,
      take,
    };
  }

  /**
   * Sets a workspace's status (M2-T3, user decisions 2026-11-18). 404 unknown/malformed id.
   * A real change writes a `workspace_status_audit_logs` row in the same transaction (the
   * workspace row is locked first, so concurrent PATCHes audit each transition once); the same
   * status again is a no-op with no audit row. Sessions are not revoked: `WorkspaceAccessGuard`
   * already answers 403 for a SUSPENDED workspace.
   */
  async updateStatus(
    workspaceId: string,
    input: { status: WorkspaceStatus; reason: string },
    adminId: string,
  ): Promise<{ client: ClientItem; changed: boolean }> {
    if (!UUID.test(workspaceId))
      throw new NotFoundException('Workspace not found');
    const changed = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: workspaces.id, status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for('update');
      if (!current) throw new NotFoundException('Workspace not found');
      if (current.status === input.status) return false;
      await tx
        .update(workspaces)
        .set({ status: input.status })
        .where(eq(workspaces.id, current.id));
      await tx.insert(workspaceStatusAuditLogs).values({
        workspaceId: current.id,
        adminId,
        oldStatus: current.status,
        newStatus: input.status,
        reason: input.reason,
      });
      return true;
    });
    const client = await this.findOne(workspaceId);
    if (!client) throw new NotFoundException('Workspace not found');
    return { client, changed };
  }

  /** One client in the list's item shape. */
  async findOne(workspaceId: string): Promise<ClientItem | undefined> {
    const rows = await this.db
      .select(workspaceColumns)
      .from(workspaces)
      .leftJoin(plans, eq(plans.id, workspaces.planId))
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const [item] = await this.withOwnersAndCounts(rows);
    return item;
  }

  /**
   * `plan` query value → `ClientListFilters.planId`: `undefined` (no filter), `null` (`none` =
   * no plan) or the plan's id. An unknown slug is a 400 (any plan, active or not, is accepted).
   */
  private async resolvePlanFilter(
    plan: string | undefined,
  ): Promise<string | null | undefined> {
    if (plan === undefined) return undefined;
    if (plan === NO_PLAN) return null;
    const [row] = await this.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.slug, plan))
      .limit(1);
    if (!row) throw new BadRequestException(`Unknown plan: ${plan}`);
    return row.id;
  }

  private async withOwnersAndCounts(
    page: WorkspaceRow[],
  ): Promise<ClientItem[]> {
    const ids = page.map((w) => w.id);
    if (!ids.length) return [];
    const [owners, memberCounts] = await Promise.all([
      this.db
        .select({
          workspaceId: workspaceMembers.workspaceId,
          id: users.id,
          email: users.email,
          name: users.name,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(
            inArray(workspaceMembers.workspaceId, ids),
            eq(workspaceMembers.role, 'owner'),
          ),
        )
        .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.id)),
      this.db
        .select({
          workspaceId: workspaceMembers.workspaceId,
          total: count(),
        })
        .from(workspaceMembers)
        .where(inArray(workspaceMembers.workspaceId, ids))
        .groupBy(workspaceMembers.workspaceId),
    ]);

    // Oldest owner wins if a workspace has several.
    const ownerOf = new Map<string, ClientOwner>();
    for (const { workspaceId, ...owner } of owners) {
      if (!ownerOf.has(workspaceId)) ownerOf.set(workspaceId, owner);
    }
    const membersOf = new Map(
      memberCounts.map((m) => [m.workspaceId, m.total]),
    );
    return page.map((w) => ({
      ...w,
      owner: ownerOf.get(w.id) ?? null,
      memberCount: membersOf.get(w.id) ?? 0,
    }));
  }
}
