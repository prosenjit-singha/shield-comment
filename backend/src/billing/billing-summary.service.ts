import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  paymentTransactions,
  plans,
  subscriptions,
} from '../db/schema/index.js';
import {
  countPooledActivePages,
  findWorkspaceBilling,
} from '../meta/social-pages.queries.js';
import { findLiveSubscription } from '../wallet/live-subscription.queries.js';
import { WalletService } from '../wallet/wallet.service.js';
import { AutoRenewState } from './auto-renew.js';
import { renewalOf, toBillingSummary } from './billing-summary.js';
import { PENDING_PAYMENT_TTL_MS } from './checkout.service.js';
import {
  accountHadTrial,
  findSummarySubscription,
} from './billing-summary.queries.js';
import type { BillingSummary } from './dto/billing-summary.dto.js';
import { LimitService } from './limit.service.js';

/**
 * The client billing summary (PW-T6; user decisions 2026-11-19 PW-D9 paused when nothing is live,
 * PW-D11 one pool per client account). Read-only; every query is scoped by the workspace id and/or
 * its own billing account id. Reuses the shared live-subscription query, the wallet balance,
 * `LimitService.workspaceCount` and the pooled Pages count.
 */
@Injectable()
export class BillingSummaryService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly wallet: WalletService,
    private readonly limits: LimitService,
    private readonly autoRenew: AutoRenewState,
  ) {}

  async summary(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<BillingSummary> {
    const [billing, live] = await Promise.all([
      findWorkspaceBilling(this.db, workspaceId),
      findLiveSubscription(this.db, workspaceId, now),
    ]);
    const accountId = billing?.billingAccountId ?? null;
    const [
      subscription,
      balance,
      workspaceCount,
      activePages,
      hadTrial,
      pendingPayment,
      scheduled,
      autoRenew,
    ] = await Promise.all([
      accountId
        ? findSummarySubscription(
            this.db,
            accountId,
            live?.subscriptionId ?? null,
          )
        : undefined,
      live ? this.wallet.balance(workspaceId, 'monthlyComments', now) : null,
      accountId ? this.limits.workspaceCount(accountId) : 1,
      countPooledActivePages(this.db, workspaceId),
      accountId ? accountHadTrial(this.db, accountId) : true,
      accountId ? this.pendingPayment(accountId, now) : null,
      live ? this.scheduled(live.subscriptionId, now) : null,
      this.autoRenew.view(accountId),
    ]);
    return toBillingSummary({
      live,
      subscription: subscription ?? null,
      balance,
      workspaceCount,
      activePages,
      // PR-T3: the trial endpoint needs an account, no live plan and no trial ever (reading 1).
      trialEligible: !hadTrial && live === null,
      renewal: renewalOf(live, scheduled !== null, now),
      pendingPayment,
      scheduled,
      autoRenew,
    });
  }

  /** The account's newest PENDING payment not yet expired (reading 9). */
  private async pendingPayment(accountId: string, now: Date) {
    const [row] = await this.db
      .select({
        tranId: paymentTransactions.tranId,
        amountBdt: paymentTransactions.amountBdt,
        createdAt: paymentTransactions.createdAt,
      })
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.billingAccountId, accountId),
          eq(paymentTransactions.status, 'PENDING'),
          gt(
            paymentTransactions.createdAt,
            new Date(now.getTime() - PENDING_PAYMENT_TTL_MS),
          ),
        ),
      )
      .orderBy(desc(paymentTransactions.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * The live row's scheduled change (M8-D7b) while its term runs; once the term ended the live
   * plan already reads as the scheduled term (`findLiveSubscription`), so `null`.
   */
  private async scheduled(subscriptionId: string, now: Date) {
    const [row] = await this.db
      .select({
        planId: plans.id,
        planName: plans.name,
        interval: subscriptions.scheduledInterval,
        startsAt: subscriptions.currentTermEnd,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.scheduledPlanId))
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          gt(subscriptions.currentTermEnd, now),
        ),
      );
    return row?.interval ? { ...row, interval: row.interval } : null;
  }
}
