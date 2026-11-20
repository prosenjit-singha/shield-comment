import { Module } from '@nestjs/common';
import { AlertSettingsController } from './alert-settings.controller.js';
import { AlertSettingsService } from './alert-settings.service.js';

/** Scam-spike alerts (Module 7). M7-T7: settings API (`alert_settings`, `alert_deliveries`). */
@Module({
  controllers: [AlertSettingsController],
  providers: [AlertSettingsService],
})
export class AlertsModule {}
