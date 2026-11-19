import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { countDistinct, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  billingAccounts,
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

/**
 * Pure rule (PW-D11): the live plan's `limits.teamSeats` minus the distinct members across the
 * account's workspaces, never below 0. No live plan → 0.
 */
export function seatsLeftOf(
  live: Pick<AccountLiveSubscription, 'plan'> | null,
  members: number,
): number {
  if (!live) return 0;
  return Math.max(0, live.plan.featureConfig.limits.teamSeats - members);
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
 * - `seatsLeft(accountId)`: for Module 7 invites (not enforced yet).
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
      this.countWorkspaces(account.id),
    ]);
    const check = workspaceCreateCheck(live, count);
    if (check.kind !== 'ok') {
      this.logger.log(
        `workspace create refused account=${account.id} reason=${check.kind} count=${count}`,
      );
    }
    return check;
  }

  /**
   * Seats left on the account (PW-D11): live plan `limits.teamSeats` − distinct members across its
   * workspaces (a user in two workspaces is one seat), floor 0; no live plan → 0. Enforced when
   * Module 7 adds invites.
   */
  async seatsLeft(accountId: string, now: Date = new Date()): Promise<number> {
    const [live, members] = await Promise.all([
      findAccountLiveSubscription(this.db, accountId, now),
      this.countMembers(accountId),
    ]);
    return seatsLeftOf(live, members);
  }

  /** Workspaces linked to the account (any status). */
  private async countWorkspaces(accountId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: countDistinct(workspaces.id) })
      .from(workspaces)
      .where(eq(workspaces.billingAccountId, accountId));
    return row?.value ?? 0;
  }

  /** Distinct users that are members of any of the account's workspaces. */
  private async countMembers(accountId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: countDistinct(workspaceMembers.userId) })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaces.billingAccountId, accountId));
    return row?.value ?? 0;
  }
}
