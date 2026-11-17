import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminClientsController } from './admin-clients.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [AdminClientsController],
})
export class AdminModule {}
