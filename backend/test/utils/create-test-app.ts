import { type INestApplication, Module, type Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { TELEGRAM_CONFIG } from '../../src/alerts/telegram.client.js';
import { EMAIL_SETTINGS } from '../../src/email/email.service.js';
import { configureApp } from '../../src/app.setup.js';
import { AUTH_SECONDARY_STORAGE } from '../../src/redis/redis-secondary-storage.js';
import { RedisService } from '../../src/redis/redis.service.js';
import { overrideQueues } from './fake-queue.js';
import { useFakeWorkers } from './fake-worker.js';
import { createMemorySecondaryStorage } from './memory-secondary-storage.js';

/**
 * Boots the real AppModule with production wiring. Redis is stubbed unless overridden; Better Auth's
 * `secondaryStorage` is an in-memory store (`app.get(AUTH_SECONDARY_STORAGE)` to inspect it) and
 * every BullMQ queue is a `FakeQueue` (`fakeQueue(app, name)`) and every `@Processor` gets a
 * `FakeWorker` (no real BullMQ `Worker`; call the processor's `process(job)`), so no spec opens a
 * Redis connection.
 * `controllers` adds test-only controllers (e.g. to probe guards) next to the app's own.
 */
export async function createTestApp(
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  controllers: Type[] = [],
): Promise<INestApplication<App>> {
  @Module({ controllers })
  class TestControllersModule {}

  useFakeWorkers();
  let builder = Test.createTestingModule({
    imports: [AppModule, TestControllersModule],
  })
    .overrideProvider(RedisService)
    .useValue({
      ping: vi.fn().mockResolvedValue('PONG'),
      evictionPolicy: vi.fn().mockResolvedValue('noeviction'),
      onModuleDestroy: vi.fn(),
    })
    .overrideProvider(AUTH_SECONDARY_STORAGE)
    .useValue(createMemorySecondaryStorage())
    // Never real Resend, even if a local .env has a key: unconfigured email only logs (M7-T4).
    // Specs that assert emails override `EmailService` with `createEmailServiceFake()`.
    .overrideProvider(EMAIL_SETTINGS)
    .useValue({ resend: null, production: false })
    // Never the real Bot API either, even if a local .env sets TELEGRAM_*: unconfigured by default.
    // Telegram specs override `TELEGRAM_CONFIG` again with the local stub (the later override wins).
    .overrideProvider(TELEGRAM_CONFIG)
    .useValue(null);
  builder = overrideQueues(builder);
  if (override) builder = override(builder);
  // Same as main.ts: the Better Auth integration owns body parsing.
  const app = (await builder.compile()).createNestApplication<
    INestApplication<App>
  >({
    bodyParser: false,
  });
  configureApp(app);
  await app.init();
  return app;
}

/** Unique, valid email per call so specs never collide on the shared test database. */
export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${crypto.randomUUID()}@test.shield.bd`;
}
