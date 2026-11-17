import { HealthService } from './health.service.js';
import type { Database } from '../db/database.js';
import type { RedisService } from '../redis/redis.service.js';

function makeService(
  db: () => Promise<unknown>,
  redis: () => Promise<string>,
): HealthService {
  const database = { execute: vi.fn(db) } as unknown as Database;
  const redisSvc = { ping: vi.fn(redis) } as unknown as RedisService;
  return new HealthService(database, redisSvc);
}

describe('HealthService', () => {
  it('reports ok when database and redis respond', async () => {
    const report = await makeService(
      async () => [1],
      async () => 'PONG',
    ).check();
    expect(report.status).toBe('ok');
    expect(report.database).toBe('up');
    expect(report.redis).toBe('up');
    expect(report.latencyMs.database).toBeTypeOf('number');
  });

  it('reports database down when the query fails', async () => {
    const report = await makeService(
      async () => Promise.reject(new Error('ECONNREFUSED')),
      async () => 'PONG',
    ).check();
    expect(report.status).toBe('error');
    expect(report.database).toBe('down');
    expect(report.latencyMs.database).toBeNull();
    expect(report.redis).toBe('up');
  });

  it('reports redis down when ping fails', async () => {
    const report = await makeService(
      async () => [1],
      async () => Promise.reject(new Error('down')),
    ).check();
    expect(report.redis).toBe('down');
    expect(report.status).toBe('error');
  });
});
