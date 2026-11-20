import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
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
import {
  validateAttachments,
  type UploadedImage,
} from './ticket-attachments.js';
import { TicketFilesInterceptor } from './ticket-files.interceptor.js';

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
   * notes never change the status. Emits `ticket.replied` after the commit. JSON, or
   * `multipart/form-data` with up to 3 images in `files` (D4, M7-T3), replies and notes alike.
   */
  @Post(':ticketId/reply')
  @UseInterceptors(TicketFilesInterceptor)
  reply(
    @Param('ticketId') ticketId: string,
    @Body() body: ReplyTicketDto,
    @Session() session: AuthSession,
    @UploadedFiles() files: UploadedImage[] | undefined,
  ) {
    return this.tickets.addMessage(ticketId, {
      senderId: session.user.id,
      senderRole: 'ADMIN',
      body: body.body,
      isInternalNote: body.isInternalNote,
      images: validateAttachments(files),
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
