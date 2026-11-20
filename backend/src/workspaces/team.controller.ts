import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { IMPERSONATION_READ_ONLY } from '../auth/workspace-invites.js';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto.js';
import {
  OwnershipTransferService,
  type TransferMethod,
} from './ownership-transfer.service.js';
import { TeamService, type TeamView } from './team.service.js';

/** D2: an impersonated session reads the team but never changes it. */
function assertNotImpersonated(session: AuthSession): void {
  if (session.session.impersonatedBy)
    throw new ForbiddenException({
      message: 'Team changes are not allowed while impersonating.',
      code: IMPERSONATION_READ_ONLY,
    });
}

/**
 * `GET /api/workspaces/:workspaceId/team` (C11, M7-T6, reading 5): every member, an impersonated
 * session too (D2; the guard keeps it on its own workspace); non-members 404. Team changes go
 * through the Better Auth organization endpoints (no wrapper write routes), except the ownership
 * transfer (D11, M7-T6b): owner only, never impersonated.
 */
@Controller('workspaces/:workspaceId/team')
@UseGuards(WorkspaceAccessGuard)
export class TeamController {
  constructor(
    private readonly team: TeamService,
    private readonly transfers: OwnershipTransferService,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  get(@CurrentWorkspace() workspace: WorkspaceContext): Promise<TeamView> {
    return this.team.team(workspace.id);
  }

  /** `{ method: 'password' | 'code' }`: `code` when the owner has no password (Google only). */
  @Get('transfer-ownership')
  @Roles('owner')
  @Header('Cache-Control', 'private, no-store')
  async transferMethod(
    @Session() session: AuthSession,
  ): Promise<{ method: TransferMethod }> {
    return { method: await this.transfers.method(session.user.id) };
  }

  /** Emails a 6-digit code (code method only): `{ expiresAt, resendAt }`. */
  @Post('transfer-ownership/code')
  @Roles('owner')
  @HttpCode(200)
  sendTransferCode(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Session() session: AuthSession,
  ) {
    assertNotImpersonated(session);
    return this.transfers.sendCode(workspace.id, session.user);
  }

  /** Verifies the owner, swaps owner ↔ admin, moves the billing account; returns the new team view. */
  @Post('transfer-ownership')
  @Roles('owner')
  @HttpCode(200)
  transferOwnership(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Session() session: AuthSession,
    @Body() body: TransferOwnershipDto,
  ): Promise<TeamView> {
    assertNotImpersonated(session);
    return this.transfers.transfer(workspace.id, session.user.id, body);
  }
}
