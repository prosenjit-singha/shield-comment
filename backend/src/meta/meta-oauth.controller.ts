import {
  Controller,
  Get,
  Query,
  Redirect,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type {
  AuthRequest,
  AuthSession,
  WorkspaceContext,
} from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { MetaOAuthUrlQueryDto } from './dto/meta-oauth-url-query.dto.js';
import { MetaOAuthService } from './meta-oauth.service.js';

/**
 * `GET /api/workspaces/:workspaceId/meta/oauth/url` (D5): owner/admin (moderator 403, non-member
 * 404), impersonated session 403, workspace must be the session's active one (409), 503 when Meta
 * or the token cipher isn't configured. Returns `{ url }` (the Meta dialog), nothing else.
 */
@Controller('workspaces/:workspaceId/meta/oauth')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin')
export class MetaOAuthUrlController {
  constructor(private readonly oauth: MetaOAuthService) {}

  @Get('url')
  url(
    @Session() session: AuthSession,
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query() query: MetaOAuthUrlQueryDto,
  ): Promise<{ url: string }> {
    return this.oauth.createLoginUrl(session, workspace, query.returnTo);
  }
}

/**
 * `GET /api/meta/oauth/callback` (D6): Meta redirects the browser here on the **client** origin
 * (same-origin proxy), so the session cookie rides along. `@Public()` so a missing session still
 * gets a redirect (`reason=unauthenticated`) instead of a JSON 401; the service checks the session
 * itself. Always a 302 to `<CLIENT_APP_URL><returnTo>?meta=…`; the query is read raw (Meta adds
 * `error_reason`, `error_description`, … that a DTO would reject).
 */
@Controller('meta/oauth')
export class MetaOAuthCallbackController {
  constructor(private readonly oauth: MetaOAuthService) {}

  @Public()
  @Get('callback')
  @Redirect()
  async callback(@Req() request: AuthRequest): Promise<{ url: string }> {
    const url = await this.oauth.handleCallback(
      request.query as Record<string, unknown>,
      request.session,
    );
    return { url };
  }
}
