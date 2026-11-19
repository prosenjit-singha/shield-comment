import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { UpdateClientStatusDto } from './dto/update-client-status.dto.js';

@Controller('admin/clients')
@UseGuards(SuperAdminGuard)
export class AdminClientsController {
  constructor(
    private readonly clients: AdminClientsService,
    private readonly impersonation: AdminImpersonationService,
  ) {}

  /**
   * `{ items: [{ id, name, slug, status, createdAt, plan, subscription, comments, owner,
   * memberCount }], total, skip, take }` (PW-T6b: `plan` = the live subscription's
   * `{ id, slug, name } | null`, see `ClientBilling`). Filters: `q` (name/slug/owner email/owner
   * name), `status`, `createdFrom`/`createdTo`, `plan` (slug on the live subscription, or `none` =
   * no live plan; unknown slug → 400); `sort` = newest (default) | oldest | name.
   */
  @Get()
  list(@Query() query: ListClientsQueryDto) {
    return this.clients.list(query);
  }

  /**
   * Suspend/activate a client: `{ status, reason }` → `{ client, changed }`. Audit-logged when the
   * status changes; the same status again is an idempotent no-op (200, `changed: false`).
   */
  @Patch(':workspaceId/status')
  updateStatus(
    @Param('workspaceId') workspaceId: string,
    @Body() body: UpdateClientStatusDto,
    @Session() session: AuthSession,
  ) {
    return this.clients.updateStatus(workspaceId, body, session.user.id);
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
