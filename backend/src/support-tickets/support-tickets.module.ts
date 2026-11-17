import { Module } from '@nestjs/common';
import { AdminTicketsController } from './admin-tickets.controller.js';
import { SupportTicketsService } from './support-tickets.service.js';
import { TicketEvents } from './ticket-events.js';

/**
 * Support tickets (Module 2, M2-T7): admin inbox under `/api/admin/tickets`. Client-side ticket
 * endpoints come later and reuse `SupportTicketsService.addMessage()`. `TicketEvents` is exported
 * so notifications can subscribe to `ticket.replied`.
 */
@Module({
  controllers: [AdminTicketsController],
  providers: [SupportTicketsService, TicketEvents],
  exports: [SupportTicketsService, TicketEvents],
})
export class SupportTicketsModule {}
