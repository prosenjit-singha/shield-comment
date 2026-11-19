import { Module } from '@nestjs/common';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { PlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

/** Public plan list (PW-T6; promotions PR-T2). Drizzle is global. */
@Module({
  imports: [PromotionsModule],
  controllers: [PlansController],
  providers: [PlansService],
})
export class PlansModule {}
