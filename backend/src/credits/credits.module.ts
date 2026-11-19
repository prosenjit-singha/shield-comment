import { Module } from '@nestjs/common';
import { CreditService } from './credit.service.js';

/**
 * Monthly AI credits (Module 5, M5-T11, D15). No routes: `CreditService` is used by the
 * admin views (M5-T13) only; the worker uses the wallet since PW-T4. Removed by PW-T6b. Drizzle comes from the global `DbModule`.
 */
@Module({
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditsModule {}
