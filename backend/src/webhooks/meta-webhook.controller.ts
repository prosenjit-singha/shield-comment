import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  type RawBodyRequest,
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
import { MetaWebhookReceiver } from './meta-webhook.receiver.js';
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
    private readonly receiver: MetaWebhookReceiver,
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
   * Event delivery. The guard has checked the HMAC of `req.rawBody` (the only body: `req.body` is
   * left unparsed). Kept comment changes become `comment-ingest` jobs; anything we don't use still
   * gets 200 (Meta retries non-200s). Enqueue failure/timeout → 503 so Meta retries.
   */
  @Post()
  @HttpCode(200)
  @UseGuards(MetaWebhookSignatureGuard)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    await this.receiver.receive(request.rawBody ?? Buffer.alloc(0));
    response.type('text/plain');
    return 'EVENT_RECEIVED';
  }
}
