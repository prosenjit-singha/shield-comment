import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { AdminBillingController } from './admin-billing.controller.js';
import { AdminBillingService } from './admin-billing.service.js';
import { AdminClientsController } from './admin-clients.controller.js';
import { AdminClientsService } from './admin-clients.service.js';
import { AdminDashboardController } from './admin-dashboard.controller.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { AdminImpersonationService } from './admin-impersonation.service.js';
import { AdminSystemController } from './admin-system.controller.js';
import { AdminSystemService } from './admin-system.service.js';

/** Super admin API (`/api/admin/*`). Every controller here uses `SuperAdminGuard`. */
@Module({
  imports: [HealthModule],
  controllers: [
    AdminClientsController,
    AdminDashboardController,
    AdminBillingController,
    AdminSystemController,
  ],
  providers: [
    AdminBillingService,
    AdminClientsService,
    AdminDashboardService,
    AdminImpersonationService,
    AdminSystemService,
  ],
})
export class AdminModule {}
