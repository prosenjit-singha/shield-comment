import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { AdminTicketsController } from './admin-tickets.controller.js';
import { ClientTicketsController } from './client-tickets.controller.js';
import { ClientTicketsService } from './client-tickets.service.js';
import { SupportTicketsService } from './support-tickets.service.js';
import { TicketAttachmentsService } from './ticket-attachments.js';
import { TicketEvents } from './ticket-events.js';

/**
 * Support tickets: admin inbox under `/api/admin/tickets` (M2-T7) + client tickets under
 * `/api/workspaces/:workspaceId/support/tickets` (M7-T2, reuses `SupportTicketsService.addMessage()`).
 * `TicketEvents` is exported so notifications can subscribe to `ticket.replied`. Screenshots
 * (M7-T3, D4) go to `StorageService` through `TicketAttachmentsService`.
 */
@Module({
  imports: [StorageModule],
  controllers: [AdminTicketsController, ClientTicketsController],
  providers: [
    SupportTicketsService,
    ClientTicketsService,
    TicketAttachmentsService,
    TicketEvents,
  ],
  exports: [SupportTicketsService, TicketEvents],
})
export class SupportTicketsModule {}
