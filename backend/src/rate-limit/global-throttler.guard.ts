import {
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthRequest } from '../auth/auth-session.js';
import { clientIp } from '../common/http/client-ip.js';

/**
 * Global limits (D2): per signed-in user, else per resolved client IP (`TRUST_PROXY_HOPS`, M9-T1).
 * One bucket per tracker across all routes.
 */
export const GLOBAL_THROTTLE = {
  name: 'global',
  ttl: 60_000,
  user: 300,
  anonymous: 60,
} as const;

/** 429 `code` of the global throttler (per-route throttles keep the library's body). */
export const RATE_LIMITED = 'RATE_LIMITED';

type TrackedRequest = Pick<AuthRequest, 'headers'> & {
  session?: AuthRequest['session'];
};

/** `user:<id>` with a session (an impersonated session = the client user it acts as), else `ip:<ip>`. */
export function globalThrottleTracker(req: TrackedRequest): string {
  const userId = req.session?.user.id;
  return userId ? `user:${userId}` : `ip:${clientIp(req) ?? 'unknown'}`;
}

/**
 * Global `APP_GUARD` (M9-T2, D2): one named throttler `global`, 300 / min per signed-in user,
 * 60 / min per anonymous IP, keys `throttle:global:<tracker>` in Redis. Registered after the
 * Better Auth guard (RateLimitModule is imported after AuthModule), so `req.session` is set;
 * requests that guard rejects (401) are not counted.
 * Opt out with `@SkipThrottle({ global: true })`: health, the Meta + Telegram webhooks and the
 * routes with their own limits (per-route `@UseGuards(ThrottlerGuard)` uses the module's
 * `default` throttler, which this guard never runs, so nothing is counted twice).
 * Over the limit → 429 `RATE_LIMITED` (our error shape via `AllExceptionsFilter`) + `Retry-After`
 * (seconds).
 */
@Injectable()
export class GlobalThrottlerGuard extends ThrottlerGuard {
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = [
      {
        name: GLOBAL_THROTTLE.name,
        ttl: GLOBAL_THROTTLE.ttl,
        limit: (context: ExecutionContext) =>
          context.switchToHttp().getRequest<TrackedRequest>().session
            ? GLOBAL_THROTTLE.user
            : GLOBAL_THROTTLE.anonymous,
        getTracker: (req) => globalThrottleTracker(req as TrackedRequest),
        generateKey: (_context, tracker) =>
          `${GLOBAL_THROTTLE.name}:${tracker}`,
        // Only `Retry-After` on a 429 (below), without the `-global` suffix the library would add.
        setHeaders: false,
      },
    ];
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(detail.timeToBlockExpire));
    throw new HttpException(
      {
        error: 'Too Many Requests',
        message: 'Too many requests. Try again in a minute.',
        code: RATE_LIMITED,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
