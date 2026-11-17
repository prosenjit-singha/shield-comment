import { Module } from '@nestjs/common';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

@Module({
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceAccessGuard],
  exports: [WorkspacesService, WorkspaceAccessGuard],
})
export class WorkspacesModule {}
