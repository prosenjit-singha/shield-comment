import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { clientIpMiddleware } from './common/http/client-ip.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import {
  META_WEBHOOK_PATH,
  metaWebhookRawBody,
} from './webhooks/meta-webhook-raw-body.js';

/**
 * Global HTTP wiring shared by `main.ts` and the e2e tests, so tests exercise exactly
 * what production runs: client IP, Helmet, `/api` prefix, Meta webhook raw body, strict validation,
 * normalised errors, CORS.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  // First: `X-Forwarded-For` becomes the one resolved client IP (TRUST_PROXY_HOPS, M9-T1), so
  // Better Auth, `req.ip` (trust proxy = that single hop) and every tracker read the same value.
  // Read like CORS_ORIGINS below; env.validation.ts has already checked it (int 0–10) at boot.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  (app as NestExpressApplication).set('trust proxy', 1);
  // Fly.io only (M9-T14a): the edge's `Fly-Client-IP` wins over the hops rule.
  app.use(clientIpMiddleware(hops, process.env.TRUST_FLY_CLIENT_IP === 'true'));
  // JSON API: Helmet defaults (incl. no `X-Powered-By`); the HTML origins set their own (M9-T8).
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  // Before init(): runs ahead of the Better Auth integration's body parsers (module middleware), so
  // the Meta webhook HMAC is checked on the exact bytes (M4-T3). Only that route; POST only.
  app.use(META_WEBHOOK_PATH, metaWebhookRawBody());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const origins = process.env.CORS_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins?.length ? origins : false,
    credentials: true,
  });
}
