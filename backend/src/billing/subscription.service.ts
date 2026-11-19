import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { Database } from '../db/database.js';
import { inListSql } from '../db/schema/check-sql.js';
import {
  billingAccounts,
  LIVE_SUBSCRIPTION_STATUSES,
  plans,
  subscriptions,
  TRIAL_PLAN_SLUG,
  workspaces,
} from '../db/schema/index.js';
import {
  type AccountLiveSubscription,
  findLiveSubscription,
  type LiveSubscription,
} from '../wallet/live-subscription.queries.js';
import {
  type WalletExecutor,
  WalletService,
} from '../wallet/wallet.service.js';
import { trialEndsAt } from './trial.js';

/** The Drizzle methods the billing writes need (db or a transaction). */
export type BillingExecutor = WalletExecutor;

/** What `setUpOwner()` left in place. */
export interface OwnerBilling {
  billingAccountId: string;
  /** The trial started now, or `null` (the account already had a subscription / no trial days). */
  trialSubscriptionId: string | null;
}

/** `status in ('TRIALING', 'ACTIVE')` as a literal list, so it matches the partial indexes. */
const LIVE_STATUS_SQL = sql.raw(
  inListSql(`"subscriptions"."status"`, LIVE_SUBSCRIPTION_STATUSES),
);

/**
 * Billing accounts and subscriptions (PW-T3; user decisions 2026-11-19 PW-D8 Starter trial at
 * sign-up once per account, PW-D9 expiry, PW-D12 trial comment limit, PW-D15). Payments,
 * renewals and plan changes are Module 8; manual activation is PW-T9.
 *
 * - The account is the paying "client" (one per owner user); every workspace points at the
 *   creator's account (`workspaces.billing_account_id`), so plan limits are pooled (PW-D11).
 * - A trial is a `TRIALING` subscription on the active `starter` plan (`TRIAL_PLAN_SLUG`) whose
 *   end (`trial_days` at trial start) is stored once, plus **one** wallet period granted
 *   `trial_comment_limit ?? limits.monthlyComments` at trial start: a later admin change of either
 *   only affects new trials.
 * - Readers treat `now ≥ current_term_end` as over (`findLiveSubscription`); `expireDue()` (the
 *   `subscription-expiry` job, every 15 min) only records it as `EXPIRED`.
 *
 * Every query is scoped by the account id (and the workspace id where it enters). Logs carry ids
 * and counts only.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly wallet: WalletService,
  ) {}

  /** The user's billing account id, created on first use (create-or-get on the owner unique key). */
  async ensureAccount(userId: string, tx?: BillingExecutor): Promise<string> {
    const ex = tx ?? this.db;
    const [created] = await ex
      .insert(billingAccounts)
      .values({ ownerUserId: userId })
      .onConflictDoNothing({ target: billingAccounts.ownerUserId })
      .returning({ id: billingAccounts.id });
    if (created) {
      this.logger.debug(
        `billing account created account=${created.id} user=${userId}`,
      );
      return created.id;
    }
    const [row] = await ex
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, userId));
    if (!row) throw new Error(`Billing account of user ${userId} not found`);
    return row.id;
  }

  /**
   * Links the workspace to the user's account (created on first use) when it has none yet; a
   * workspace keeps its account for life. Returns the user's account id. For `/organization/create`
   * (no trial) and sign-up.
   */
  async linkWorkspace(
    userId: string,
    workspaceId: string,
    tx?: BillingExecutor,
  ): Promise<string> {
    const ex = tx ?? this.db;
    const accountId = await this.ensureAccount(userId, ex);
    await ex
      .update(workspaces)
      .set({ billingAccountId: accountId })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          isNull(workspaces.billingAccountId),
        ),
      );
    return accountId;
  }

  /**
   * Starts the Starter trial (PW-D8) at `now` when the account has **no** subscription row at all
   * (once per account, also after expiry/cancel) and the active `starter` plan has `trial_days`.
   * Inserts the `TRIALING` subscription and opens its wallet period with the trial grant, in the
   * caller's transaction (`tx`) or its own. Concurrent calls are serialised on the account row
   * (`FOR UPDATE`) and the partial unique index backs that up. Returns the subscription id, or
   * `null` (already had one / no trial plan).
   */
  async startTrial(
    accountId: string,
    now: Date = new Date(),
    tx?: BillingExecutor,
  ): Promise<string | null> {
    const run = async (ex: BillingExecutor): Promise<string | null> => {
      const [account] = await ex
        .select({ id: billingAccounts.id })
        .from(billingAccounts)
        .where(eq(billingAccounts.id, accountId))
        .for('update');
      if (!account) throw new Error(`Billing account ${accountId} not found`);
      const [existing] = await ex
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.billingAccountId, accountId))
        .limit(1);
      if (existing) return null;
      const [plan] = await ex
        .select({
          id: plans.id,
          slug: plans.slug,
          trialDays: plans.trialDays,
          trialCommentLimit: plans.trialCommentLimit,
          featureConfig: plans.featureConfig,
        })
        .from(plans)
        .where(and(eq(plans.slug, TRIAL_PLAN_SLUG), eq(plans.isActive, true)));
      if (!plan || plan.trialDays === null) {
        this.logger.debug(`no trial plan account=${accountId}`);
        return null;
      }
      const end = trialEndsAt(now, plan.trialDays);
      const [inserted] = await ex
        .insert(subscriptions)
        .values({
          billingAccountId: accountId,
          planId: plan.id,
          interval: 'month',
          status: 'TRIALING',
          startedAt: now,
          trialEndsAt: end,
          currentTermStart: now,
          currentTermEnd: end,
        })
        .onConflictDoNothing()
        .returning({ id: subscriptions.id });
      if (!inserted) return null;
      const live: AccountLiveSubscription = {
        billingAccountId: accountId,
        subscriptionId: inserted.id,
        status: 'TRIALING',
        interval: 'month',
        startedAt: now,
        trialEndsAt: end,
        currentTermStart: now,
        currentTermEnd: end,
        plan: {
          id: plan.id,
          slug: plan.slug,
          featureConfig: normalizeFeatureConfig(plan.featureConfig),
          trialCommentLimit: plan.trialCommentLimit,
        },
      };
      await this.wallet.openSubscriptionPeriod(live, now, ex);
      this.logger.log(
        `trial started account=${accountId} subscription=${inserted.id} days=${plan.trialDays}`,
      );
      return inserted.id;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  /**
   * Sign-up (and its repair on a later session create): the user's account, the workspace linked
   * to it, and the trial when the account never had a subscription. Idempotent; pass `tx` to run
   * in the transaction that creates the workspace.
   */
  async setUpOwner(
    userId: string,
    workspaceId: string,
    now: Date = new Date(),
    tx?: BillingExecutor,
  ): Promise<OwnerBilling> {
    const run = async (ex: BillingExecutor): Promise<OwnerBilling> => {
      const billingAccountId = await this.linkWorkspace(
        userId,
        workspaceId,
        ex,
      );
      const trialSubscriptionId = await this.startTrial(
        billingAccountId,
        now,
        ex,
      );
      return { billingAccountId, trialSubscriptionId };
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  /**
   * `true` when the workspace is linked to an account that has (or had) a subscription: nothing
   * for `setUpOwner()` to repair. One query (the session-create check).
   */
  async isSetUp(workspaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: subscriptions.id })
      .from(workspaces)
      .innerJoin(
        subscriptions,
        eq(subscriptions.billingAccountId, workspaces.billingAccountId),
      )
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return row !== undefined;
  }

  /** The workspace's live plan at `now` (`findLiveSubscription`), or `null`. */
  activePlan(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<LiveSubscription | null> {
    return findLiveSubscription(this.db, workspaceId, now);
  }

  /**
   * Marks every live subscription whose term ended (`current_term_end <= now`) as `EXPIRED` in one
   * guarded UPDATE (partial index `subscriptions_live_term_end_index`). Readers already treat
   * those as over, so a late run never extends a plan. Returns the number of rows changed.
   */
  async expireDue(now: Date = new Date()): Promise<number> {
    if (Number.isNaN(now.getTime())) {
      throw new RangeError('expireDue needs a valid date');
    }
    const rows = await this.db
      .update(subscriptions)
      .set({ status: 'EXPIRED' })
      .where(and(LIVE_STATUS_SQL, lte(subscriptions.currentTermEnd, now)))
      .returning({
        id: subscriptions.id,
        billingAccountId: subscriptions.billingAccountId,
      });
    if (rows.length > 0) {
      this.logger.log(`subscriptions expired: ${rows.length}`);
      this.logger.debug(
        `expired ${rows.map((r) => `${r.id}@${r.billingAccountId}`).join(', ')}`,
      );
    }
    return rows.length;
  }
}
