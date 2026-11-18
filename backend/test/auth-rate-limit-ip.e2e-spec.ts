import type { INestApplication } from '@nestjs/common';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { normalizeIP } from '@better-auth/core/utils/ip';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { createBetterAuth } from '../src/auth/better-auth.js';
import { AUTH_SECONDARY_STORAGE } from '../src/redis/redis-secondary-storage.js';
import { TRUSTED_ORIGIN } from './utils/auth-actors.js';
import { createTestApp, uniqueEmail } from './utils/create-test-app.js';
import type { createMemorySecondaryStorage } from './utils/memory-secondary-storage.js';

type MemoryStorage = ReturnType<typeof createMemorySecondaryStorage>;
type BetterAuth = ReturnType<typeof createBetterAuth>;

const SIGN_IN = '/sign-in/email';
/** `customRules['/sign-in/email']` in src/auth/better-auth.ts. */
const SIGN_IN_MAX = 10;
/**
 * The app listens on IPv6 loopback, so the socket bucket (`::1` → Better Auth's /64 form) can't be
 * mistaken for Better Auth's own dev/test fallback (127.0.0.1).
 */
const SOCKET_IP = normalizeIP('::1');
const PROXIED_IP = '203.0.113.9';

/**
 * M4-T10 (D11): Better Auth rate-limit keys use `X-Forwarded-For`, else the socket address; nothing
 * lands in the shared `no-trusted-ip|<path>` bucket. Rate limiting is off under NODE_ENV=test, so
 * this spec switches it on in its own app. Only failed sign-ins of unknown emails: no rows created.
 */
describe('Better Auth rate-limit client IP (e2e)', () => {
  let app: INestApplication<App>;
  let storage: MemoryStorage;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    const auth = app.get<AuthService<BetterAuth>>(AuthService).instance;
    const context = await auth.$context;
    context.rateLimit.enabled = true;
    storage = app.get<MemoryStorage>(AUTH_SECONDARY_STORAGE);
    await app.listen(0, '::1');
    baseUrl = await app.getUrl();
    expect(baseUrl).toMatch(/^http:\/\/\[::1\]:\d+$/);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    for (const key of storage.keys()) void storage.delete(key);
  });

  function signIn(forwardedFor?: string) {
    const req = request(baseUrl)
      .post(`/api/auth${SIGN_IN}`)
      .set('Origin', TRUSTED_ORIGIN);
    if (forwardedFor !== undefined) req.set('X-Forwarded-For', forwardedFor);
    return req.send({
      email: uniqueEmail('rate-ip'),
      password: 'wrong-password-1',
    });
  }

  function rateLimitKeys(): Record<string, string | null> {
    return Object.fromEntries(
      storage
        .keys()
        .filter((key) => key.includes('|'))
        .map((key) => [key, storage.get(key) as string | null]),
    );
  }

  it('counts direct requests (no X-Forwarded-For) in the socket-address bucket', async () => {
    await signIn().expect(401);
    await signIn().expect(401);

    expect(rateLimitKeys()).toEqual({ [`${SOCKET_IP}|${SIGN_IN}`]: '2' });
  });

  it('keeps the header IP for proxied requests', async () => {
    await signIn().expect(401);
    await signIn(PROXIED_IP).expect(401);

    expect(rateLimitKeys()).toEqual({
      [`${SOCKET_IP}|${SIGN_IN}`]: '1',
      [`${PROXIED_IP}|${SIGN_IN}`]: '1',
    });
  });

  it.each([
    ['empty', ''],
    ['garbage', 'unknown'],
    ['a list', `198.51.100.1, ${PROXIED_IP}`],
  ])('uses the socket address when X-Forwarded-For is %s', async (_n, xff) => {
    await signIn(xff).expect(401);

    expect(rateLimitKeys()).toEqual({ [`${SOCKET_IP}|${SIGN_IN}`]: '1' });
  });

  it('limits the socket bucket on its own; a proxied client keeps its own budget', async () => {
    for (let i = 0; i < SIGN_IN_MAX; i += 1) await signIn().expect(401);

    await signIn().expect(429);
    await signIn(PROXIED_IP).expect(401);

    const keys = rateLimitKeys();
    expect(Object.keys(keys).sort()).toEqual(
      [`${PROXIED_IP}|${SIGN_IN}`, `${SOCKET_IP}|${SIGN_IN}`].sort(),
    );
    expect(Object.keys(keys).some((k) => k.startsWith('no-trusted-ip'))).toBe(
      false,
    );
  });
});
