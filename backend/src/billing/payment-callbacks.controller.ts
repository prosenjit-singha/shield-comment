import {
  Body,
  Controller,
  HttpCode,
  Post,
  Redirect,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import { isRetryOutcome, successReturn } from './payment-callback.js';
import { PaymentCallbacksService } from './payment-callbacks.service.js';

/**
 * Per caller IP: the last `X-Forwarded-For` hop (added by the client's same-origin proxy, the only
 * way in, reading 4), else the socket address.
 */
const perIp = Throttle({
  default: {
    limit: 60,
    ttl: 60_000,
    getTracker: (req) => {
      const { headers, ip } = req as Request;
      const forwarded = headers['x-forwarded-for'];
      const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
        ?.split(',')
        .pop()
        ?.trim();
      return `sslcommerz:${last || ip || 'none'}`;
    },
  },
});

type Form = Record<string, unknown>;

/**
 * SSLCommerz callbacks (M8-T5, reading 4), `@Public()`: SSLCommerz's server (IPN) and the payer's
 * browser (cross-site form POSTs, no session cookie) reach them through `CLIENT_APP_URL/api/…`.
 * `application/x-www-form-urlencoded` bodies (the Better Auth integration's urlencoded parser
 * covers every non-auth route). Rate-limited per IP (60 / min).
 * - `POST ipn` → 200 `{ received: true }` for every final outcome (no retry storm); 503 only for
 *   transient ones (validator unreachable, activation failed, not configured) so SSLCommerz retries.
 * - `POST success|fail|cancel` → 303 `CLIENT_APP_URL/billing?payment=success|failed|cancelled|pending&tranId=…`.
 */
@Public()
@UseGuards(ThrottlerGuard)
@perIp
@Controller('billing/sslcommerz')
export class PaymentCallbacksController {
  constructor(private readonly callbacks: PaymentCallbacksService) {}

  @Post('ipn')
  @HttpCode(200)
  async ipn(@Body() body: Form): Promise<{ received: true }> {
    const { outcome } = await this.callbacks.settle('IPN', body);
    if (isRetryOutcome(outcome))
      throw new ServiceUnavailableException('Try again later');
    return { received: true };
  }

  @Post('success')
  @Redirect(undefined, 303)
  async success(@Body() body: Form): Promise<{ url: string }> {
    const { tranId, outcome } = await this.callbacks.settle('SUCCESS', body);
    return { url: this.callbacks.returnUrl(successReturn(outcome), tranId) };
  }

  @Post('fail')
  @Redirect(undefined, 303)
  async fail(@Body() body: Form): Promise<{ url: string }> {
    const { tranId } = await this.callbacks.close('FAIL', body);
    return { url: this.callbacks.returnUrl('failed', tranId) };
  }

  @Post('cancel')
  @Redirect(undefined, 303)
  async cancel(@Body() body: Form): Promise<{ url: string }> {
    const { tranId } = await this.callbacks.close('CANCEL', body);
    return { url: this.callbacks.returnUrl('cancelled', tranId) };
  }
}
