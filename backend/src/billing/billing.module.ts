import { Module } from '@nestjs/common';
import { TokenCipherModule } from '../crypto/token-cipher.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AutoRenewState } from './auto-renew.js';
import { AutoRenewService } from './auto-renew.service.js';
import { BillingJobSchedulers } from './billing-job-schedulers.js';
import { BillingSummaryController } from './billing-summary.controller.js';
import { BillingSummaryService } from './billing-summary.service.js';
import { BillingProcessor } from './billing.processor.js';
import { CheckoutService } from './checkout.service.js';
import { PaymentCallbacksController } from './payment-callbacks.controller.js';
import { PaymentCallbacksService } from './payment-callbacks.service.js';
import { InvoicesService } from './invoices.service.js';
import { LimitService } from './limit.service.js';
import { RenewalReminderService } from './renewal-reminder.service.js';
import { SubscriptionService } from './subscription.service.js';

/**
 * Billing accounts + subscriptions (PW-T3): `SubscriptionService` (workspace link, trial by
 * choice (PR-T3), live plan, expiry), the `billing` queue worker and its `subscription-expiry`
 * scheduler (every 15 min, registered at startup) + `LimitService` (PW-T5: account-pooled
 * workspace and seat limits) + the client `GET /api/workspaces/:workspaceId/billing/summary`
 * (PW-T6, `BillingSummaryService`), `POST …/billing/trial` (PR-T3) and `POST …/billing/{coupon,checkout}`
 * (M8-T4, `CheckoutService` → `PaymentsModule`), `GET …/billing/payments/:tranId` + the `@Public()`
 * SSLCommerz callbacks `/api/billing/sslcommerz/{ipn,success,fail,cancel}` (M8-T5,
 * `PaymentCallbacksService`), the M8-T6 jobs (`renewal-reminders` → `RenewalReminderService`,
 * `pending-payment-expiry`, the M8-D7b switch in `subscription-expiry`), M8-T6b tokenized
 * auto-renew (`AutoRenewState` + `PUT/DELETE …/billing/auto-renew`, `auto-renew-charge` →
 * `AutoRenewService`, only with `SSLCOMMERZ_TOKENIZATION=true`), M8-T7 client invoices (`InvoicesService`, `GET …/billing/invoices`). Imported by `AppModule`
 * and by the Better Auth module (sign-up + `/organization/create` hooks). Drizzle and the queues
 * are global.
 */
@Module({
  imports: [WalletModule, PromotionsModule, PaymentsModule, TokenCipherModule],
  controllers: [BillingSummaryController, PaymentCallbacksController],
  providers: [
    BillingSummaryService,
    SubscriptionService,
    CheckoutService,
    InvoicesService,
    PaymentCallbacksService,
    LimitService,
    RenewalReminderService,
    AutoRenewState,
    AutoRenewService,
    BillingProcessor,
    BillingJobSchedulers,
  ],
  exports: [SubscriptionService, LimitService],
})
export class BillingModule {}
