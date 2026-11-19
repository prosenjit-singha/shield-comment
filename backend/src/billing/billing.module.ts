import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module.js';
import { BillingJobSchedulers } from './billing-job-schedulers.js';
import { BillingProcessor } from './billing.processor.js';
import { SubscriptionService } from './subscription.service.js';

/**
 * Billing accounts + subscriptions (PW-T3): `SubscriptionService` (sign-up trial, workspace link,
 * live plan, expiry), the `billing` queue worker and its `subscription-expiry` scheduler (every
 * 15 min, registered at startup). No routes yet (PW-T6). Imported by `AppModule` and by the Better
 * Auth module (sign-up + `/organization/create` hooks). Drizzle and the queues are global.
 */
@Module({
  imports: [WalletModule],
  providers: [SubscriptionService, BillingProcessor, BillingJobSchedulers],
  exports: [SubscriptionService],
})
export class BillingModule {}
