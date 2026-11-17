import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession } from '../auth/auth-session.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import {
  ListTicketsQueryDto,
  ReplyTicketDto,
  UpdateTicketStatusDto,
} from './dto/tickets.dto.js';
import { SupportTicketsService } from './support-tickets.service.js';

/** Super admin ticket inbox (A5). Impersonated sessions get 403 from `SuperAdminGuard`. */
@Controller('admin/tickets')
@UseGuards(SuperAdminGuard)
export class AdminTicketsController {
  constructor(private readonly tickets: SupportTicketsService) {}

  /**
   * `{ items: TicketListItem[], total, skip, take }`, newest first. Filters: `status`, `category`,
   * `priority`, `workspaceId`, `q` (subject).
   */
  @Get()
  list(@Query() query: ListTicketsQueryDto) {
    return this.tickets.list(query);
  }

  /** The ticket + its thread, oldest first, internal notes included. */
  @Get(':ticketId')
  detail(@Param('ticketId') ticketId: string) {
    return this.tickets.detail(ticketId);
  }

  /**
   * 201 `{ message, ticket }`. A public reply on an OPEN ticket moves it to IN_PROGRESS; internal
   * notes never change the status. Emits `ticket.replied` after the commit.
   */
  @Post(':ticketId/reply')
  reply(
    @Param('ticketId') ticketId: string,
    @Body() body: ReplyTicketDto,
    @Session() session: AuthSession,
  ) {
    return this.tickets.addMessage(ticketId, {
      senderId: session.user.id,
      senderRole: 'ADMIN',
      body: body.body,
      isInternalNote: body.isInternalNote,
    });
  }

  /** `{ ticket, changed }`: any status → any status; the same status again is a no-op. */
  @Patch(':ticketId/status')
  updateStatus(
    @Param('ticketId') ticketId: string,
    @Body() body: UpdateTicketStatusDto,
  ) {
    return this.tickets.updateStatus(ticketId, body.status);
  }
}
