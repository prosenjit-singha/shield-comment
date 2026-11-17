import { Module } from '@nestjs/common';
import { AdminClientsController } from './admin-clients.controller.js';
import { AdminClientsService } from './admin-clients.service.js';
import { AdminImpersonationService } from './admin-impersonation.service.js';

/** Super admin API (`/api/admin/*`). Every controller here uses `SuperAdminGuard`. */
@Module({
  controllers: [AdminClientsController],
  providers: [AdminClientsService, AdminImpersonationService],
})
export class AdminModule {}
