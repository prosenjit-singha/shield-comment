import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AlertSettingsController,
  AlertTestController,
} from './alert-settings.controller.js';
import { AlertDispatchService } from './alert-dispatch.service.js';
import { AlertStore, RedisAlertStore } from './alert.store.js';
import { AlertsProcessor } from './alerts.processor.js';
import { ScamSpikeDetector } from './scam-spike.detector.js';
import { AlertSettingsService } from './alert-settings.service.js';
import {
  createTelegramConfig,
  TELEGRAM_CONFIG,
  TelegramClient,
} from './telegram.client.js';
import {
  TelegramLinkController,
  TelegramWebhookController,
} from './telegram.controller.js';
import { TelegramLinkService } from './telegram-link.service.js';
import { RedisTelegramLinkStore, TelegramLinkStore } from './telegram-link.js';

/**
 * Scam-spike alerts (Module 7). M7-T7: settings API (`alert_settings`, `alert_deliveries`).
 * M7-T8: Telegram platform bot (`TelegramClient`, link codes, webhook, `telegram_chats`).
 * M7-T9: `ScamSpikeDetector` (exported; the moderation worker calls it) → `alerts` queue →
 * `AlertsProcessor` → `AlertDispatchService` (email + Telegram, `alert_deliveries`) + test alerts.
 */
@Module({
  controllers: [
    AlertSettingsController,
    AlertTestController,
    TelegramLinkController,
    TelegramWebhookController,
  ],
  providers: [
    AlertSettingsService,
    {
      provide: TELEGRAM_CONFIG,
      inject: [ConfigService],
      useFactory: createTelegramConfig,
    },
    TelegramClient,
    TelegramLinkService,
    { provide: TelegramLinkStore, useClass: RedisTelegramLinkStore },
    { provide: AlertStore, useClass: RedisAlertStore },
    AlertDispatchService,
    AlertsProcessor,
    ScamSpikeDetector,
  ],
  exports: [ScamSpikeDetector],
})
export class AlertsModule {}
