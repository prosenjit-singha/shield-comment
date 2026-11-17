import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { getDrizzleToken } from '@nestjs/drizzle';
import { RedisService } from '../src/redis/redis.service.js';
import { createTestApp } from './utils/create-test-app.js';

describe('GET /api/health (e2e)', () => {
  let app: INestApplication<App>;
  const db = { execute: vi.fn() };
  const redis = { ping: vi.fn(), onModuleDestroy: vi.fn() };

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(getDrizzleToken())
        .useValue(db)
        .overrideProvider(RedisService)
        .useValue(redis),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with database and redis up', async () => {
    db.execute.mockResolvedValueOnce([1]);
    redis.ping.mockResolvedValueOnce('PONG');
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      database: 'up',
      redis: 'up',
    });
  });

  it('returns 503 when a dependency is down', async () => {
    db.execute.mockRejectedValueOnce(new Error('down'));
    redis.ping.mockResolvedValueOnce('PONG');
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(503);
    expect(res.body).toMatchObject({
      status: 'error',
      database: 'down',
      redis: 'up',
    });
  });

  it('GET /api/health/live returns 200 without DB or Redis calls', async () => {
    db.execute.mockClear();
    redis.ping.mockClear();
    const res = await request(app.getHttpServer())
      .get('/api/health/live')
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(res.body.uptimeSeconds).toBeTypeOf('number');
    expect(db.execute).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });

  it('returns the normalised error shape for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/nope').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, path: '/api/nope' });
  });
});
