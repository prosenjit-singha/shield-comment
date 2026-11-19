import { Module } from '@nestjs/common';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module.js';
import { TokenCipherModule } from '../crypto/token-cipher.module.js';
import { HealthModule } from '../health/health.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AdminAiSettingsController } from './admin-ai-settings.controller.js';
import { AdminAiSettingsService } from './admin-ai-settings.service.js';
import { AdminBillingController } from './admin-billing.controller.js';
import { AdminBillingService } from './admin-billing.service.js';
import { AdminClientsController } from './admin-clients.controller.js';
import { AdminClientsService } from './admin-clients.service.js';
import { AdminDashboardController } from './admin-dashboard.controller.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { AdminImpersonationService } from './admin-impersonation.service.js';
import { AdminPlansService } from './admin-plans.service.js';
import { AdminSettingsController } from './admin-settings.controller.js';
import { AdminSystemController } from './admin-system.controller.js';
import { AdminSystemService } from './admin-system.service.js';

/** Super admin API (`/api/admin/*`). Every controller here uses `SuperAdminGuard`. */
@Module({
  imports: [HealthModule, AiGatewayModule, TokenCipherModule, WalletModule],
  controllers: [
    AdminClientsController,
    AdminDashboardController,
    AdminBillingController,
    AdminSystemController,
    AdminSettingsController,
    AdminAiSettingsController,
  ],
  providers: [
    AdminAiSettingsService,
    AdminBillingService,
    AdminClientsService,
    AdminDashboardService,
    AdminImpersonationService,
    AdminPlansService,
    AdminSystemService,
  ],
})
export class AdminModule {}
