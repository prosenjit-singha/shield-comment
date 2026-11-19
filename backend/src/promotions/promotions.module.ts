import { Module } from '@nestjs/common';
import { PromotionService } from './promotion.service.js';

/**
 * Promotions (PR-T2): `PromotionService` (live rules, claims, coupon check). The admin API
 * (PR-T4) lives in `src/admin/admin-promotions.*`; the public coupon endpoint comes in Module 8.
 * Drizzle is global.
 */
@Module({
  providers: [PromotionService],
  exports: [PromotionService],
})
export class PromotionsModule {}
