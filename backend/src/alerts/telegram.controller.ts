import {
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { TELEGRAM_CONFIG, type TelegramConfig } from './telegram.client.js';
import {
  type TelegramLinkResponse,
  TelegramLinkService,
} from './telegram-link.service.js';
import { isTelegramSecretValid } from './telegram-link.js';

/**
 * C12 Telegram linking (M7-T8, D13): owner/admin (moderators 403, non-members 404); D2: an
 * impersonated session may link and remove chats (alert settings).
 */
@Controller('workspaces/:workspaceId/alerts/telegram')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin')
export class TelegramLinkController {
  constructor(private readonly telegram: TelegramLinkService) {}

  /**
   * One-time link, valid 15 min → `{ url, groupUrl, expiresAt }`. 503 `TELEGRAM_NOT_CONFIGURED`,
   * 409 `PLAN_FEATURE_UNAVAILABLE` (`details { feature: 'messengerAlerts' }`), 409
   * `TELEGRAM_CHAT_LIMIT` (`details { max: 3 }`).
   */
  @Post('link')
  link(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Session() session: AuthSession,
  ): Promise<TelegramLinkResponse> {
    return this.telegram.createLink(workspace.id, session.user.id);
  }

  /** `chatId` = the row id from `telegram.chats[].id`. 204, or 404 unknown/foreign. */
  @Delete('chats/:chatId')
  @HttpCode(204)
  async remove(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('chatId', new ParseUUIDPipe()) chatId: string,
  ): Promise<void> {
    await this.telegram.removeChat(workspace.id, chatId);
  }
}

/**
 * Bot webhook (`setWebhook` url + `secret_token`). Telegram calls the backend directly, no session.
 * Wrong/missing secret → 401; not configured → 503; every update with a valid secret → 200
 * (Telegram retries non-2xx), handled or ignored.
 */
@Public()
// Telegram bursts; the secret header guards it (D2).
@SkipThrottle({ global: true })
@Controller('telegram/webhook')
export class TelegramWebhookController {
  constructor(
    @Inject(TELEGRAM_CONFIG) private readonly config: TelegramConfig | null,
    private readonly telegram: TelegramLinkService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: unknown,
  ): Promise<void> {
    if (!this.config)
      throw new ServiceUnavailableException('Telegram is not configured');
    if (!isTelegramSecretValid(secret, this.config.webhookSecret))
      throw new UnauthorizedException('Invalid webhook secret');
    await this.telegram.handleUpdate(update);
  }
}
