import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type RawBodyRequest,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  META_WEBHOOK_CONFIG,
  type MetaWebhookConfig,
} from './meta-webhook.config.js';
import {
  checkMetaWebhookSignature,
  META_SIGNATURE_HEADER,
} from './meta-webhook-signature.js';

/**
 * Lets a Meta webhook `POST` through only when `X-Hub-Signature-256` is the HMAC-SHA256 of the raw
 * body (`req.rawBody`, see `metaWebhookRawBody`) with `META_APP_SECRET`.
 * Missing/malformed/wrong signature → 401 (D1). Meta app vars unset → 503.
 * Logs the reason only, never the header value.
 */
@Injectable()
export class MetaWebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(MetaWebhookSignatureGuard.name);

  constructor(
    @Inject(META_WEBHOOK_CONFIG) private readonly config: MetaWebhookConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const appSecret = this.config.appSecret;
    if (!appSecret) {
      throw new ServiceUnavailableException('Meta webhooks are not configured');
    }
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const rawBody = request.rawBody;
    const result = rawBody
      ? checkMetaWebhookSignature(
          rawBody,
          request.headers[META_SIGNATURE_HEADER],
          appSecret,
        )
      : 'missing';
    if (result !== 'ok') {
      this.logger.warn(`Meta webhook rejected: signature ${result}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return true;
  }
}
