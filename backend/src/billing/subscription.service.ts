import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { inListSql } from '../db/schema/check-sql.js';
import {
  billingAccounts,
  LIVE_SUBSCRIPTION_STATUSES,
  plans,
  subscriptions,
  workspaces,
} from '../db/schema/index.js';
import {
  PROMOTION_ERROR_CODES,
  PromotionService,
} from '../promotions/promotion.service.js';
import {
  findAccountLiveSubscription,
  findLiveSubscription,
  type LiveSubscription,
} from '../wallet/live-subscription.queries.js';
import {
  type WalletExecutor,
  WalletService,
} from '../wallet/wallet.service.js';
import { accountHadTrial } from './billing-summary.queries.js';
import { trialEndsAt } from './trial.js';

/** The Drizzle methods the billing writes need (db or a transaction). */
export type BillingExecutor = WalletExecutor;

/** `startTrial()` 4xx codes (body `{ message, code }`); `redeem()`'s 409 codes pass through. */
export const TRIAL_ERROR_CODES = {
  /** 409: the workspace has no billing account. */
  noBillingAccount: 'NO_BILLING_ACCOUNT',
  /** 409: the account already has a live (TRIALING / ACTIVE) subscription. */
  planAlreadyActive: 'PLAN_ALREADY_ACTIVE',
  /** 400: unknown or inactive plan. */
  planNotAvailable: 'PLAN_NOT_AVAILABLE',
  /** 409: no live TRIAL promotion targets the plan (none, ended, stopped or used up). */
  trialNotAvailable: 'TRIAL_NOT_AVAILABLE',
} as const;

/** `status in ('TRIALING', 'ACTIVE')` as a literal list, so it matches the partial indexes. */
const LIVE_STATUS_SQL = sql.raw(
  inListSql(`"subscriptions"."status"`, LIVE_SUBSCRIPTION_STATUSES),
);

/**
 * Billing accounts and subscriptions (PW-T3; PW-D9 expiry, PW-D15; PR-T3: PR-D10 trial by choice,
 * reading 1 one trial per account ever). Payments, renewals and plan changes are Module 8; manual
 * activation is PW-T9.
 *
 * - The account is the paying "client" (one per owner user); every workspace points at the
 *   creator's account (`workspaces.billing_account_id`), so plan limits are pooled (PW-D11).
 *   Sign-up only links the workspace (no plan).
 * - A trial is started by the owner (`startTrial`) from a live TRIAL promotion: a `TRIALING`
 *   subscription whose end is stored once, plus **one** wallet period granted the redemption's
 *   comment limit (snapshot: a later promotion edit never changes a running trial).
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
    private readonly promotions: PromotionService,
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
   * workspace keeps its account for life. Returns the user's account id. Sign-up (and its
   * session-create repair) and `/organization/create`; never starts a plan (PR-T3).
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
   * Starts a free trial by choice (PR-T3; PR-D10, reading 1) for the workspace's billing account
   * on `planId`, in one transaction: lock the account → no live subscription → the plan is active
   * → a live TRIAL promotion targets it → the account never had a trial → `TRIALING` subscription
   * (end = now + the promotion's days × 24 h) → the redemption (`PromotionService.redeem`, its 409
   * codes pass through) linked on the subscription → the wallet period granted the redemption's
   * comment limit (`null` = the plan's monthly comments). Concurrent calls serialise on the
   * account row: the later one sees `PLAN_ALREADY_ACTIVE`. Returns the subscription id.
   */
  async startTrial(
    workspaceId: string,
    planId: string,
    now: Date = new Date(),
  ): Promise<string> {
    const conflict = (code: string, message: string) =>
      new ConflictException({ message, code });
    return this.db.transaction(async (tx) => {
      const [ws] = await tx
        .select({ billingAccountId: workspaces.billingAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      const accountId = ws?.billingAccountId;
      if (!accountId)
        throw conflict(
          TRIAL_ERROR_CODES.noBillingAccount,
          'This workspace has no billing account',
        );
      await tx
        .select({ id: billingAccounts.id })
        .from(billingAccounts)
        .where(eq(billingAccounts.id, accountId))
        .for('update');
      if (await findAccountLiveSubscription(tx, accountId, now))
        throw conflict(
          TRIAL_ERROR_CODES.planAlreadyActive,
          'This account already has a plan',
        );
      const [plan] = await tx
        .select({ id: plans.id })
        .from(plans)
        .where(and(eq(plans.id, planId), eq(plans.isActive, true)));
      if (!plan)
        throw new BadRequestException({
          message: 'This plan is not available',
          code: TRIAL_ERROR_CODES.planNotAvailable,
        });
      const trial = await this.promotions.liveTrialFor(planId, now);
      if (!trial)
        throw conflict(
          TRIAL_ERROR_CODES.trialNotAvailable,
          'No free trial is available for this plan',
        );
      // Also counts sign-up trials from before PR-T3 (no redemption row).
      if (await accountHadTrial(tx, accountId))
        throw conflict(
          PROMOTION_ERROR_CODES.trialAlreadyUsed,
          'This account already had a free trial',
        );

      // A live-status row past its term still holds `subscriptions_one_live_per_account` until
      // the expiry job runs: record it as EXPIRED first.
      await tx
        .update(subscriptions)
        .set({ status: 'EXPIRED' })
        .where(
          and(
            eq(subscriptions.billingAccountId, accountId),
            LIVE_STATUS_SQL,
            lte(subscriptions.currentTermEnd, now),
          ),
        );
      const end = trialEndsAt(now, trial.days);
      const [created] = await tx
        .insert(subscriptions)
        .values({
          billingAccountId: accountId,
          planId,
          interval: 'month',
          status: 'TRIALING',
          startedAt: now,
          trialEndsAt: end,
          currentTermStart: now,
          currentTermEnd: end,
        })
        .returning({ id: subscriptions.id });
      const subscriptionId = created!.id;
      const redemption = await this.promotions.redeem(
        tx,
        { promotionId: trial.promotionId, accountId, planId, subscriptionId },
        now,
      );
      await tx
        .update(subscriptions)
        .set({ promotionRedemptionId: redemption.id })
        .where(eq(subscriptions.id, subscriptionId));
      // Re-read: the grant comes from the redemption snapshot (`findAccountLiveSubscription`).
      const live = await findAccountLiveSubscription(tx, accountId, now);
      await this.wallet.openSubscriptionPeriod(live!, now, tx);
      this.logger.log(
        `trial started account=${accountId} workspace=${workspaceId} subscription=${subscriptionId} promotion=${trial.promotionId} days=${trial.days}`,
      );
      return subscriptionId;
    });
  }

  /**
   * `true` when the workspace is linked to a billing account: nothing for the session-create
   * repair (`linkWorkspace`) to do. One query.
   */
  async isSetUp(workspaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, workspaceId),
          isNotNull(workspaces.billingAccountId),
        ),
      );
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
