import { Module } from '@nestjs/common';
import { CreditService } from './credit.service.js';

/**
 * Monthly AI credits (Module 5, M5-T11, D15). No routes: `CreditService` is used by the
 * moderation worker (M5-T12) and the admin views (M5-T13). Drizzle comes from the global `DbModule`.
 */
@Module({
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditsModule {}
