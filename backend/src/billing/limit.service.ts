import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, countDistinct, eq, gt, sql } from 'drizzle-orm';
import { union } from 'drizzle-orm/pg-core';
import type { Database } from '../db/database.js';
import {
  billingAccounts,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from '../db/schema/index.js';
import {
  type AccountLiveSubscription,
  findAccountLiveSubscription,
} from '../wallet/live-subscription.queries.js';

/** `code` of the 403s from `POST /api/auth/organization/create` (PW-T5, plan §3.6). */
export const WORKSPACE_CREATE_ERROR_CODES = {
  /** The creator's billing account has no live plan (none, trial or term over). */
  noActivePlan: 'no_active_plan',
  /** The account already has `limits.workspaces` workspaces; `details { limit, count }`. */
  limitReached: 'workspace_limit_reached',
} as const;

/** Whether the user may create one more workspace (`/organization/create`). */
export type WorkspaceCreateCheck =
  | { kind: 'ok'; limit: number; count: number }
  | { kind: 'no_active_plan' }
  | { kind: 'limit_reached'; limit: number; count: number };

/**
 * Pure rule (PW-D10/D11): no live plan → `no_active_plan`; `count` (the account's workspaces) ≥
 * the plan's `limits.workspaces` → `limit_reached`; else `ok`.
 */
export function workspaceCreateCheck(
  live: Pick<AccountLiveSubscription, 'plan'> | null,
  count: number,
): WorkspaceCreateCheck {
  if (!live) return { kind: 'no_active_plan' };
  const limit = live.plan.featureConfig.limits.workspaces;
  return count >= limit
    ? { kind: 'limit_reached', limit, count }
    : { kind: 'ok', limit, count };
}

/** `code` of the 409s from `POST /api/auth/organization/invite-member` (M7-T5, Module 7 D9/D10). */
export const SEAT_ERROR_CODES = {
  /** The workspace's billing account has no live plan. */
  noActivePlan: 'NO_ACTIVE_PLAN',
  /** Seats used (members + pending invites) ≥ `limits.teamSeats`; `details { limit, used }`. */
  limitReached: 'SEAT_LIMIT_REACHED',
} as const;

/** Whether one more person may be invited to the account's workspaces. */
export type SeatCheck =
  | { kind: 'ok'; limit: number; used: number }
  | { kind: 'no_active_plan'; used: number }
  | { kind: 'limit_reached'; limit: number; used: number };

/**
 * Pure rule (PW-D11, Module 7 D9): the live plan's `limits.teamSeats` minus the seats used
 * (distinct people across the account's workspaces: members incl. the owner + pending unexpired
 * invites), never below 0. No live plan → 0.
 */
export function seatsLeftOf(
  live: Pick<AccountLiveSubscription, 'plan'> | null,
  used: number,
): number {
  if (!live) return 0;
  return Math.max(0, live.plan.featureConfig.limits.teamSeats - used);
}

/** Pure rule (D9/D10): an invite needs a live plan and a free seat (over the limit stays refused). */
export function seatCheckOf(
  live: Pick<AccountLiveSubscription, 'plan'> | null,
  used: number,
): SeatCheck {
  if (!live) return { kind: 'no_active_plan', used };
  const limit = live.plan.featureConfig.limits.teamSeats;
  return used >= limit
    ? { kind: 'limit_reached', limit, used }
    : { kind: 'ok', limit, used };
}

/**
 * Pure rule (D9/D10, M7-T6) at accept: the invite being accepted is already one of the `used` seats
 * (pending, unexpired) and turns into a member with the same email, so only **over** the limit
 * (e.g. after a downgrade) is refused.
 */
export function acceptSeatCheckOf(
  live: Pick<AccountLiveSubscription, 'plan'> | null,
  used: number,
): SeatCheck {
  if (!live) return { kind: 'no_active_plan', used };
  const limit = live.plan.featureConfig.limits.teamSeats;
  return used > limit
    ? { kind: 'limit_reached', limit, used }
    : { kind: 'ok', limit, used };
}

/** The team route's seat meter (M7-T6): `limit` null without a live plan. */
export interface SeatUsage {
  used: number;
  limit: number | null;
}

/**
 * Plan limits pooled per billing account (PW-T5; user decisions 2026-11-19 PW-D10 workspaces,
 * PW-D11 one pool per client account). Pages are pooled in `SocialPagesService` and comments in
 * the wallet; this service holds the account-level ones:
 *
 * - `canCreateWorkspace(userId)`: the Better Auth `/organization/create` before-hook (403
 *   `no_active_plan` / `workspace_limit_reached`). The creator's **own** account counts (the new
 *   workspace is linked to it by the after-hook); the first workspace at sign-up is created by
 *   `first-workspace.ts`, not through this check.
 * - `canInvite(workspaceId)`: the `/organization/invite-member` seat check (M7-T5, D9/D10);
 *   `canAccept(workspaceId)`: the `/organization/accept-invitation` re-check (M7-T6);
 *   `seatUsage(workspaceId)`: the team route's `{ used, limit }`; `seatsLeft(accountId)`: a number.
 * - `workspaceCount(accountId)`: also read by `BillingSummaryService` (PW-T6).
 *
 * Read-only; every query is scoped by the account id (or the owner user id that finds it). Logs
 * carry ids and counts only.
 */
@Injectable()
export class LimitService {
  private readonly logger = new Logger(LimitService.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * May `userId` create one more workspace? Their billing account (as owner) must have a live plan
   * with room under `limits.workspaces`. No account yet = no live plan. Not locked: two parallel
   * creates of one account can both pass (Better Auth runs the hook outside a transaction).
   */
  async canCreateWorkspace(
    userId: string,
    now: Date = new Date(),
  ): Promise<WorkspaceCreateCheck> {
    const [account] = await this.db
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, userId));
    if (!account) return workspaceCreateCheck(null, 0);
    const [live, count] = await Promise.all([
      findAccountLiveSubscription(this.db, account.id, now),
      this.workspaceCount(account.id),
    ]);
    const check = workspaceCreateCheck(live, count);
    if (check.kind !== 'ok') {
      this.logger.log(
        `workspace create refused account=${account.id} reason=${check.kind} count=${count}`,
      );
    }
    return check;
  }

  /** Seats left on the account (D9): live plan `limits.teamSeats` − `countSeats`, floor 0; no live plan → 0. */
  async seatsLeft(accountId: string, now: Date = new Date()): Promise<number> {
    const [live, used] = await Promise.all([
      findAccountLiveSubscription(this.db, accountId, now),
      this.countSeats(accountId, now),
    ]);
    return seatsLeftOf(live, used);
  }

  /**
   * May one more person be invited to `workspaceId` (D9/D10)? Seats are pooled on the workspace's
   * billing account; no account = no live plan. Not locked: two parallel invites can both pass the
   * last seat (Better Auth runs the hook outside a transaction); accept re-checks (M7-T6).
   */
  async canInvite(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<SeatCheck> {
    return this.seatCheck('invite', workspaceId, now);
  }

  /**
   * May a pending invite to `workspaceId` be accepted (M7-T6, D9/D10)? Refused only when the
   * account is already **over** its seats (the invite is counted in `used`), or has no live plan.
   */
  async canAccept(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<SeatCheck> {
    return this.seatCheck('accept', workspaceId, now);
  }

  /** Seats used / limit of the workspace's billing account (team route, M7-T6). */
  async seatUsage(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<SeatUsage> {
    const { live, used } = await this.seatState(workspaceId, now);
    return { used, limit: live?.plan.featureConfig.limits.teamSeats ?? null };
  }

  private async seatCheck(
    action: 'invite' | 'accept',
    workspaceId: string,
    now: Date,
  ): Promise<SeatCheck> {
    const { accountId, live, used } = await this.seatState(workspaceId, now);
    const check = (action === 'invite' ? seatCheckOf : acceptSeatCheckOf)(
      live,
      used,
    );
    if (check.kind !== 'ok') {
      this.logger.log(
        `${action} refused account=${accountId} reason=${check.kind} used=${used}`,
      );
    }
    return check;
  }

  private async seatState(workspaceId: string, now: Date) {
    const [ws] = await this.db
      .select({ accountId: workspaces.billingAccountId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!ws?.accountId) return { accountId: null, live: null, used: 0 };
    const [live, used] = await Promise.all([
      findAccountLiveSubscription(this.db, ws.accountId, now),
      this.countSeats(ws.accountId, now),
    ]);
    return { accountId: ws.accountId, live, used };
  }

  /**
   * Workspaces linked to the account (any status): the `workspaces.used` of the create check and
   * of the client billing summary (PW-T6).
   */
  async workspaceCount(accountId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: countDistinct(workspaces.id) })
      .from(workspaces)
      .where(eq(workspaces.billingAccountId, accountId));
    return row?.value ?? 0;
  }

  /**
   * Seats used (D9): distinct people across the account's workspaces, by lower-cased email =
   * members (owner included) ∪ pending unexpired invites. A person in two workspaces, or a member
   * invited to another of the account's workspaces, is one seat.
   */
  private async countSeats(accountId: string, now: Date): Promise<number> {
    const memberEmails = this.db
      .select({ email: sql<string>`lower(${users.email})`.as('email') })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaces.billingAccountId, accountId));
    const invitedEmails = this.db
      .select({
        email: sql<string>`lower(${workspaceInvitations.email})`.as('email'),
      })
      .from(workspaceInvitations)
      .innerJoin(
        workspaces,
        eq(workspaces.id, workspaceInvitations.workspaceId),
      )
      .where(
        and(
          eq(workspaces.billingAccountId, accountId),
          eq(workspaceInvitations.status, 'pending'),
          gt(workspaceInvitations.expiresAt, now),
        ),
      );
    const seats = union(memberEmails, invitedEmails).as('seats');
    const [row] = await this.db
      .select({ value: countDistinct(seats.email) })
      .from(seats);
    return row?.value ?? 0;
  }
}
