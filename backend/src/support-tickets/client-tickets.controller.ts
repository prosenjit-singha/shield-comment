import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import {
  CLIENT_TICKET_ERROR_CODES,
  ClientTicketsService,
  type TicketViewer,
} from './client-tickets.service.js';
import {
  ClientReplyTicketDto,
  CreateTicketDto,
  TicketsPageQueryDto,
} from './dto/tickets.dto.js';

const viewerOf = (
  workspace: WorkspaceContext,
  session: AuthSession,
): TicketViewer => ({
  workspaceId: workspace.id,
  role: workspace.role,
  userId: session.user.id,
});

/** D2: an impersonated session would write as the client, so it may only read. */
function assertNotImpersonated(session: AuthSession): void {
  if (session.session.impersonatedBy)
    throw new ForbiddenException({
      message: 'Support tickets are read-only while impersonating',
      error: 'Forbidden',
      code: CLIENT_TICKET_ERROR_CODES.impersonationReadOnly,
    });
}

/**
 * Client support tickets (C13, M7-T2; D1 every member, moderators see only their own; D2
 * impersonated = read-only; D3 support sets priority/status). Unknown, foreign or hidden tickets
 * are 404. The same tickets show up on `/api/admin/tickets` unchanged.
 */
@Controller('workspaces/:workspaceId/support/tickets')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin', 'moderator')
export class ClientTicketsController {
  constructor(private readonly tickets: ClientTicketsService) {}

  /** `{ items: ClientTicketItem[], total, skip, take }`, newest activity first. */
  @Get()
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Session() session: AuthSession,
    @Query() query: TicketsPageQueryDto,
  ) {
    return this.tickets.list(viewerOf(workspace, session), query);
  }

  /** 201 `ClientTicketDetail`. 409 `TICKET_LIMIT_REACHED` at 20 unresolved tickets. */
  @Post()
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Session() session: AuthSession,
    @Body() body: CreateTicketDto,
  ) {
    assertNotImpersonated(session);
    return this.tickets.create(viewerOf(workspace, session), body);
  }

  /** The ticket + its public thread (never internal notes; support shown as "Support"). */
  @Get(':ticketId')
  detail(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Session() session: AuthSession,
    @Param('ticketId') ticketId: string,
  ) {
    return this.tickets.detail(viewerOf(workspace, session), ticketId);
  }

  /** 201 `{ message, ticket }`; a reply on a RESOLVED ticket reopens it. */
  @Post(':ticketId/reply')
  reply(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Session() session: AuthSession,
    @Param('ticketId') ticketId: string,
    @Body() body: ClientReplyTicketDto,
  ) {
    assertNotImpersonated(session);
    return this.tickets.reply(
      viewerOf(workspace, session),
      ticketId,
      body.body,
    );
  }
}
