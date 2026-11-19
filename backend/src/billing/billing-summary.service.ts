import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../db/database.js';
import {
  countPooledActivePages,
  findWorkspaceBilling,
} from '../meta/social-pages.queries.js';
import { findLiveSubscription } from '../wallet/live-subscription.queries.js';
import { WalletService } from '../wallet/wallet.service.js';
import { toBillingSummary } from './billing-summary.js';
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
    const [subscription, balance, workspaceCount, activePages, hadTrial] =
      await Promise.all([
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
      ]);
    return toBillingSummary({
      live,
      subscription: subscription ?? null,
      balance,
      workspaceCount,
      activePages,
      // PR-T3: the trial endpoint needs an account, no live plan and no trial ever (reading 1).
      trialEligible: !hadTrial && live === null,
    });
  }
}
