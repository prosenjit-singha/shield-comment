import { type INestApplication, Module, type Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { RedisService } from '../../src/redis/redis.service.js';

/**
 * Boots the real AppModule with production wiring. Redis is stubbed unless overridden.
 * `controllers` adds test-only controllers (e.g. to probe guards) next to the app's own.
 */
export async function createTestApp(
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  controllers: Type[] = [],
): Promise<INestApplication<App>> {
  @Module({ controllers })
  class TestControllersModule {}

  let builder = Test.createTestingModule({ imports: [AppModule, TestControllersModule] })
    .overrideProvider(RedisService)
    .useValue({ ping: vi.fn().mockResolvedValue('PONG'), onModuleDestroy: vi.fn() });
  if (override) builder = override(builder);
  // Same as main.ts: the Better Auth integration owns body parsing.
  const app = (await builder.compile()).createNestApplication<INestApplication<App>>({
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
