import { Module } from '@nestjs/common';
import { AdminBillingController } from './admin-billing.controller.js';
import { AdminBillingService } from './admin-billing.service.js';
import { AdminClientsController } from './admin-clients.controller.js';
import { AdminClientsService } from './admin-clients.service.js';
import { AdminDashboardController } from './admin-dashboard.controller.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import { AdminImpersonationService } from './admin-impersonation.service.js';

/** Super admin API (`/api/admin/*`). Every controller here uses `SuperAdminGuard`. */
@Module({
  controllers: [
    AdminClientsController,
    AdminDashboardController,
    AdminBillingController,
  ],
  providers: [
    AdminBillingService,
    AdminClientsService,
    AdminDashboardService,
    AdminImpersonationService,
  ],
})
export class AdminModule {}
