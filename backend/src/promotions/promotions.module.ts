import { Module } from '@nestjs/common';
import { PromotionService } from './promotion.service.js';

/**
 * Promotions (PR-T2): `PromotionService` (live rules, claims, coupon check). No routes yet: the
 * admin API comes in PR-T4, the public coupon endpoint in Module 8. Drizzle is global.
 */
@Module({
  providers: [PromotionService],
  exports: [PromotionService],
})
export class PromotionsModule {}
