import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

/** Public plan list (PW-T6). Drizzle is global. */
@Module({
  controllers: [PlansController],
  providers: [PlansService],
})
export class PlansModule {}
