import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { RedisService } from '../../src/redis/redis.service.js';

/** Boots the real AppModule with production wiring. Redis is stubbed unless overridden. */
export async function createTestApp(
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RedisService)
    .useValue({ ping: vi.fn().mockResolvedValue('PONG'), onModuleDestroy: vi.fn() });
  if (override) builder = override(builder);
  const app = (await builder.compile()).createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}

/** Unique, valid email per call so specs never collide on the shared test database. */
export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${crypto.randomUUID()}@test.shield.bd`;
}
