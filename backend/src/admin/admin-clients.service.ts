import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { findSummarySubscriptions } from '../billing/billing-summary.queries.js';
import type { Database } from '../db/database.js';
import {
  plans,
  users,
  workspaceMembers,
  workspaces,
  workspaceStatusAuditLogs,
} from '../db/schema/index.js';
import { findLiveSubscriptions } from '../wallet/live-subscription.queries.js';
import { type WalletBalance, WalletService } from '../wallet/wallet.service.js';
import { type ClientBilling, toClientBilling } from './client-billing.js';
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
  /** Plan slug (live subscription), or `none` for workspaces without a live plan. */
  plan?: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdAt: Date;
  billingAccountId: string | null;
}

/**
 * One client (workspace) of the super admin list. `plan`, `subscription` and `comments` come from
 * the billing account's subscriptions + wallet (PW-T6b; see `ClientBilling`).
 */
export interface ClientItem
  extends Omit<WorkspaceRow, 'billingAccountId'>, ClientBilling {
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
  billingAccountId: workspaces.billingAccountId,
};

/**
 * Super admin view of every client workspace. Cross-tenant by design (only reachable through
 * `SuperAdminGuard`); the member/owner lookups are still scoped to the page's workspace ids.
 */
@Injectable()
export class AdminClientsService {
  private readonly logger = new Logger(AdminClientsService.name);
  /** Overridable clock (tests). */
  now: () => Date = () => new Date();

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly wallet: WalletService,
  ) {}

  /** `{ items, total, skip, take }`; `total` counts every match of the filters. */
  async list(query: ClientListQuery) {
    const { skip, take, sort } = query;
    const { from, before } = createdRange(query.createdFrom, query.createdTo);
    if (from && before && from.getTime() >= before.getTime()) {
      throw new BadRequestException('createdFrom must not be after createdTo');
    }
    const planId = await this.resolvePlanFilter(query.plan);
    const now = this.now();
    const where = clientListWhere(this.db, { ...query, planId }, now);
    const [page, [totals]] = await Promise.all([
      this.db
        .select(workspaceColumns)
        .from(workspaces)
        .where(where)
        .orderBy(...clientListOrder(sort))
        .offset(skip)
        .limit(take),
      this.db.select({ total: count() }).from(workspaces).where(where),
    ]);
    return {
      items: await this.withDetails(page, now),
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
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const [item] = await this.withDetails(rows, this.now());
    return item;
  }

  /**
   * `plan` query value → `ClientListFilters.planId`: `undefined` (no filter), `null` (`none` =
   * no live plan) or the plan's id. An unknown slug is a 400 (any plan, active or not, is
   * accepted).
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

  /**
   * Owners, member counts and billing for a page of workspaces: a fixed number of batched queries
   * scoped by the page's workspace ids and their billing accounts (no N+1).
   */
  private async withDetails(
    page: WorkspaceRow[],
    now: Date,
  ): Promise<ClientItem[]> {
    const ids = page.map((w) => w.id);
    if (!ids.length) return [];
    const accountIds = page.flatMap((w) =>
      w.billingAccountId ? [w.billingAccountId] : [],
    );
    const [owners, memberCounts, subs, balances] = await Promise.all([
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
      this.subscriptionsOf(ids, accountIds, now),
      this.balancesOf(ids, now),
    ]);

    // Oldest owner wins if a workspace has several.
    const ownerOf = new Map<string, ClientOwner>();
    for (const { workspaceId, ...owner } of owners) {
      if (!ownerOf.has(workspaceId)) ownerOf.set(workspaceId, owner);
    }
    const membersOf = new Map(
      memberCounts.map((m) => [m.workspaceId, m.total]),
    );
    return page.map(({ billingAccountId, ...w }) => ({
      ...w,
      owner: ownerOf.get(w.id) ?? null,
      memberCount: membersOf.get(w.id) ?? 0,
      ...toClientBilling({
        live: subs.lives.get(w.id) ?? null,
        subscription:
          (billingAccountId && subs.byAccount.get(billingAccountId)) || null,
        balance: balances ? (balances.get(w.id) ?? null) : undefined,
      }),
    }));
  }

  /** Live subscriptions per workspace + the described subscription per account (2 queries). */
  private async subscriptionsOf(
    ids: readonly string[],
    accountIds: readonly string[],
    now: Date,
  ) {
    const lives = await findLiveSubscriptions(this.db, ids, now);
    const byAccount = await findSummarySubscriptions(
      this.db,
      accountIds,
      [...lives.values()].map((l) => l.subscriptionId),
    );
    return { lives, byAccount };
  }

  /**
   * This period's pooled `monthlyComments` balance per workspace (`null` = no live plan); the
   * whole map is `null` (logged) when the wallet read fails, so the list still answers.
   */
  private async balancesOf(
    ids: readonly string[],
    now: Date,
  ): Promise<Map<string, WalletBalance | null> | null> {
    try {
      return await this.wallet.balanceMany(ids, 'monthlyComments', now);
    } catch (error) {
      this.logger.warn(
        `Comment usage unavailable for ${ids.length} clients: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return null;
    }
  }
}
