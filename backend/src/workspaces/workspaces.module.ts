import { Module } from '@nestjs/common';
import { PasswordService } from '../auth/password.service.js';
import { BillingModule } from '../billing/billing.module.js';
import { OwnershipTransferService } from './ownership-transfer.service.js';
import {
  OwnershipTransferStore,
  RedisOwnershipTransferStore,
} from './ownership-transfer.store.js';
import { TeamController } from './team.controller.js';
import { TeamService } from './team.service.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

@Module({
  imports: [BillingModule],
  controllers: [WorkspacesController, TeamController],
  providers: [
    WorkspacesService,
    TeamService,
    OwnershipTransferService,
    PasswordService,
    { provide: OwnershipTransferStore, useClass: RedisOwnershipTransferStore },
  ],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
