import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import {
  META_WEBHOOK_CONFIG,
  type MetaWebhookConfig,
} from './meta-webhook.config.js';
import { MetaWebhookSignatureGuard } from './meta-webhook-signature.guard.js';
import { checkMetaVerifyRequest } from './meta-webhook-signature.js';

/**
 * `/api/webhooks/meta` (Module 4 D1). Meta calls the backend host directly (not the client proxy),
 * so the raw body arrives untouched. `@Public()`: Meta has no session.
 */
@Public()
@Controller('webhooks/meta')
export class MetaWebhookController {
  constructor(
    @Inject(META_WEBHOOK_CONFIG) private readonly config: MetaWebhookConfig,
  ) {}

  /**
   * Subscription handshake: `hub.mode=subscribe` + matching `hub.verify_token` → 200 echo of
   * `hub.challenge` as text; anything else → 403; `META_WEBHOOK_VERIFY_TOKEN` unset → 503.
   * The query is read raw: its keys contain dots and Meta may add fields a DTO would reject.
   */
  @Get()
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'no-store')
  verify(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): string {
    const verifyToken = this.config.verifyToken;
    if (!verifyToken) {
      throw new ServiceUnavailableException('Meta webhooks are not configured');
    }
    const result = checkMetaVerifyRequest(
      request.query as Record<string, unknown>,
      verifyToken,
    );
    if (!result.ok) {
      throw new ForbiddenException('Webhook verification failed');
    }
    // Set here, not with @Header: that would also label the JSON error bodies as text.
    response.type('text/plain');
    return result.challenge;
  }

  /**
   * Event delivery. The guard has checked the HMAC of `req.rawBody`. M4-T4 replaces this stub with
   * envelope parsing + enqueueing (Meta retries anything that isn't a fast 200).
   */
  @Post()
  @HttpCode(200)
  @UseGuards(MetaWebhookSignatureGuard)
  receive(@Res({ passthrough: true }) response: Response): string {
    response.type('text/plain');
    return 'EVENT_RECEIVED';
  }
}
