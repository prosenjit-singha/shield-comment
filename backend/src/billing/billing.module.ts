import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module.js';
import { BillingJobSchedulers } from './billing-job-schedulers.js';
import { BillingProcessor } from './billing.processor.js';
import { LimitService } from './limit.service.js';
import { SubscriptionService } from './subscription.service.js';

/**
 * Billing accounts + subscriptions (PW-T3): `SubscriptionService` (sign-up trial, workspace link,
 * live plan, expiry), the `billing` queue worker and its `subscription-expiry` scheduler (every
 * 15 min, registered at startup) + `LimitService` (PW-T5: account-pooled workspace and seat
 * limits). No routes yet (PW-T6). Imported by `AppModule` and by the Better Auth module (sign-up +
 * `/organization/create` hooks). Drizzle and the queues are global.
 */
@Module({
  imports: [WalletModule],
  providers: [
    SubscriptionService,
    LimitService,
    BillingProcessor,
    BillingJobSchedulers,
  ],
  exports: [SubscriptionService, LimitService],
})
export class BillingModule {}
