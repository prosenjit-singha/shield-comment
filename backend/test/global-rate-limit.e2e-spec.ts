import type { INestApplication } from '@nestjs/common';
import { AuthService } from '@thallesp/nestjs-better-auth';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { createBetterAuth } from '../src/auth/better-auth.js';
import { GLOBAL_THROTTLE } from '../src/rate-limit/global-throttler.guard.js';
import { createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

type BetterAuth = ReturnType<typeof createBetterAuth>;

/**
 * M9-T2 (D2): the global throttler (in-memory storage in e2e, fresh per app). 60 / min per
 * anonymous resolved client IP (TRUST_PROXY_HOPS=1: the last `X-Forwarded-For` entry), 300 / min
 * per signed-in user; skipped routes and routes with their own limits never use it. Every test
 * uses its own client IP, so the buckets never mix.
 */
describe('Global rate limit (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  /** Public, not skipped, cheap. */
  const plans = (ip: string, cookie?: string) => {
    const req = http().get('/api/plans').set('X-Forwarded-For', ip);
    return cookie ? req.set('Cookie', cookie) : req;
  };

  async function exhaustAnonymous(ip: string): Promise<request.Response> {
    for (let i = 0; i < GLOBAL_THROTTLE.anonymous; i++)
      await plans(ip).expect(200);
    return plans(ip).expect(429);
  }

  it(`answers the ${GLOBAL_THROTTLE.anonymous + 1}st anonymous request in a minute with 429 + Retry-After + our error shape`, async () => {
    const res = await exhaustAnonymous('203.0.113.10');
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Too many requests. Try again in a minute.',
      code: 'RATE_LIMITED',
      path: '/api/plans',
      timestamp: expect.any(String),
    });
    // No per-request X-RateLimit headers from the global throttler.
    expect(res.headers['x-ratelimit-limit-global']).toBeUndefined();
    // Another client has its own budget.
    await plans('203.0.113.11').expect(200);
  });

  it('a spoofed left X-Forwarded-For entry does not escape the anonymous bucket', async () => {
    for (let i = 0; i < GLOBAL_THROTTLE.anonymous; i++)
      await plans(`198.51.100.${i + 1}, 203.0.113.20`).expect(200);
    await plans('198.51.100.200, 203.0.113.20').expect(429);
  });

  it(`a signed-in user has its own ${GLOBAL_THROTTLE.user} / min budget, apart from the IP's`, async () => {
    const ip = '203.0.113.30';
    const owner = await actors.signUp('global-rl');
    await exhaustAnonymous(ip);
    for (let i = 0; i < GLOBAL_THROTTLE.user; i++)
      await plans(ip, owner.cookie).expect(200);
    const res = await http()
      .get('/api/me')
      .set('X-Forwarded-For', ip)
      .set('Cookie', owner.cookie)
      .expect(429);
    expect(res.headers['retry-after']).toBeDefined();
    // Another user from the same IP is not affected.
    const other = await actors.signUp('global-rl-other');
    await http()
      .get('/api/me')
      .set('X-Forwarded-For', ip)
      .set('Cookie', other.cookie)
      .expect(200);

    // Routes with their own limits skip the global one (the exhausted user still gets through).
    const ws = `/api/workspaces/${owner.workspaceId}`;
    for (const path of [
      'billing/coupon',
      'billing/checkout',
      'playground/test',
      'alerts/test',
    ]) {
      const res = await http()
        .post(`${ws}/${path}`)
        .set('X-Forwarded-For', ip)
        .set('Cookie', owner.cookie)
        .send({});
      expect(`${path} ${res.status}`).not.toMatch(/ 429$/);
    }
  }, 30_000);

  it('skipped routes and routes with their own limits never answer 429 from the global bucket', async () => {
    const ip = '203.0.113.40';
    await exhaustAnonymous(ip);
    const probes: [string, () => request.Test][] = [
      ['GET health/live', () => http().get('/api/health/live')],
      ['GET health', () => http().get('/api/health')],
      ['GET webhooks/meta', () => http().get('/api/webhooks/meta')],
      ['POST webhooks/meta', () => http().post('/api/webhooks/meta').send({})],
      [
        'POST telegram/webhook',
        () => http().post('/api/telegram/webhook').send({}),
      ],
      [
        'POST meta/deauthorize',
        () => http().post('/api/meta/deauthorize').type('form').send({}),
      ],
      [
        'POST sslcommerz/ipn',
        () => http().post('/api/billing/sslcommerz/ipn').type('form').send({}),
      ],
    ];
    for (const [label, probe] of probes) {
      const res = await probe().set('X-Forwarded-For', ip);
      expect(`${label} ${res.status}`).not.toMatch(/ 429$/);
    }
    // Health stays open however often it is probed.
    for (let i = 0; i < GLOBAL_THROTTLE.anonymous; i++)
      await http()
        .get('/api/health/live')
        .set('X-Forwarded-For', ip)
        .expect(200);
    // The bucket itself is still exhausted.
    await plans(ip).expect(429);
  });

  it('Better Auth keeps its rules and limits password reset to 3 / min', async () => {
    const auth = app.get<AuthService<BetterAuth>>(AuthService).instance;
    const { rateLimit } = await auth.$context;
    expect(rateLimit).toMatchObject({ window: 60, max: 100 });
    expect(rateLimit.customRules).toMatchObject({
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-up/email': { window: 60, max: 5 },
      '/get-session': false,
      '/request-password-reset': { window: 60, max: 3 },
      '/reset-password': { window: 60, max: 3 },
    });
  });
});
