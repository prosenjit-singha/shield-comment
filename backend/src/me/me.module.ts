import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { MeController } from './me.controller.js';

@Module({
  imports: [WorkspacesModule],
  controllers: [MeController],
})
export class MeModule {}
