import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth-session.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminClientsService } from './admin-clients.service.js';
import {
  AdminImpersonationService,
  requestIp,
} from './admin-impersonation.service.js';
import { ListClientsQueryDto } from './dto/list-clients-query.dto.js';

@Controller('admin/clients')
@UseGuards(SuperAdminGuard)
export class AdminClientsController {
  constructor(
    private readonly clients: AdminClientsService,
    private readonly impersonation: AdminImpersonationService,
  ) {}

  /** Newest first: `{ items: [{ id, name, slug, status, createdAt, owner, memberCount }], total, skip, take }`. */
  @Get()
  list(@Query() query: ListClientsQueryDto) {
    return this.clients.list(query.skip, query.take);
  }

  /**
   * 1-click "Login as client": `{ token, redirectUrl }` (60 s, single use, audit-logged).
   * The client app posts the token to `POST /api/auth/impersonate-exchange`.
   */
  @Post(':workspaceId/impersonate')
  @HttpCode(HttpStatus.OK)
  impersonate(
    @Param('workspaceId') workspaceId: string,
    @Session() session: AuthSession,
    @Req() req: Request,
  ) {
    return this.impersonation.issue(
      workspaceId,
      session.user.id,
      requestIp(req),
    );
  }
}
