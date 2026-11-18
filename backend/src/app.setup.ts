import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import {
  META_WEBHOOK_PATH,
  metaWebhookRawBody,
} from './webhooks/meta-webhook-raw-body.js';

/**
 * Global HTTP wiring shared by `main.ts` and the e2e tests, so tests exercise exactly
 * what production runs: `/api` prefix, Meta webhook raw body, strict validation, normalised errors,
 * CORS.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
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
