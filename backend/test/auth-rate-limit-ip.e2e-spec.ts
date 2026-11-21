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
 * M9-T1 (D2): Better Auth rate-limit keys use the resolved client IP (`TRUST_PROXY_HOPS`), never a
 * client-chosen `X-Forwarded-For`; nothing lands in the shared `no-trusted-ip|<path>` bucket. Rate
 * limiting is off under NODE_ENV=test, so this spec switches it on in its own apps. Only failed
 * sign-ins of unknown emails: no rows created.
 */
describe.each([0, 1])(
  'Better Auth rate-limit client IP, TRUST_PROXY_HOPS=%i (e2e)',
  (hops) => {
    let app: INestApplication<App>;
    let storage: MemoryStorage;
    let baseUrl: string;
    /** The bucket of a request whose proxy-added (last) entry is PROXIED_IP. */
    const proxiedBucket = hops === 0 ? SOCKET_IP : PROXIED_IP;

    beforeAll(async () => {
      vi.stubEnv('TRUST_PROXY_HOPS', String(hops));
      app = await createTestApp();
      vi.unstubAllEnvs();
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

    it('keys proxied requests on the trusted hop only; spoofed left entries are ignored', async () => {
      await signIn(PROXIED_IP).expect(401);
      await signIn(`198.51.100.1, ${PROXIED_IP}`).expect(401);
      await signIn(`198.51.100.2, 198.51.100.3, ${PROXIED_IP}`).expect(401);

      expect(rateLimitKeys()).toEqual({
        [`${proxiedBucket}|${SIGN_IN}`]: '3',
      });
    });

    it.each([
      ['empty', ''],
      ['garbage', 'unknown'],
    ])(
      'uses the socket address when X-Forwarded-For is %s',
      async (_n, xff) => {
        await signIn(xff).expect(401);

        expect(rateLimitKeys()).toEqual({ [`${SOCKET_IP}|${SIGN_IN}`]: '1' });
      },
    );

    it('a caller cannot leave its exhausted bucket by changing the spoofed entries', async () => {
      for (let i = 0; i < SIGN_IN_MAX; i += 1) {
        await signIn(`198.51.100.${i + 1}, ${PROXIED_IP}`).expect(401);
      }

      await signIn(`198.51.100.99, ${PROXIED_IP}`).expect(429);
      await signIn(`${PROXIED_IP}, 198.51.100.77`).expect(
        hops === 0 ? 429 : 401,
      );

      const keys = Object.keys(rateLimitKeys());
      expect(keys).toContain(`${proxiedBucket}|${SIGN_IN}`);
      expect(keys.some((k) => k.startsWith('no-trusted-ip'))).toBe(false);
      expect(keys.some((k) => k.startsWith('198.51.100.9'))).toBe(false);
    });
  },
);

/**
 * M9-T14a: on Fly (`TRUST_FLY_CLIENT_IP=true`) the edge's `Fly-Client-IP` picks the bucket; missing or
 * invalid → the hops rule. Off (compose/Docker default) a client-sent `Fly-Client-IP` is ignored.
 */
describe.each(['true', 'false'])(
  'Better Auth rate-limit client IP, TRUST_FLY_CLIENT_IP=%s (e2e)',
  (trustFly) => {
    let app: INestApplication<App>;
    let storage: MemoryStorage;
    const FLY_IP = '198.51.100.20';

    beforeAll(async () => {
      vi.stubEnv('TRUST_PROXY_HOPS', '1');
      vi.stubEnv('TRUST_FLY_CLIENT_IP', trustFly);
      app = await createTestApp();
      vi.unstubAllEnvs();
      const auth = app.get<AuthService<BetterAuth>>(AuthService).instance;
      (await auth.$context).rateLimit.enabled = true;
      storage = app.get<MemoryStorage>(AUTH_SECONDARY_STORAGE);
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      for (const key of storage.keys()) void storage.delete(key);
    });

    function signIn(headers: Record<string, string>) {
      return request(app.getHttpServer())
        .post(`/api/auth${SIGN_IN}`)
        .set('Origin', TRUSTED_ORIGIN)
        .set(headers)
        .send({ email: uniqueEmail('rate-fly'), password: 'wrong-password-1' });
    }

    function buckets(): string[] {
      return storage.keys().filter((key) => key.includes('|'));
    }

    it('keys on Fly-Client-IP only when the switch is on', async () => {
      await signIn({
        'Fly-Client-IP': FLY_IP,
        'X-Forwarded-For': `203.0.113.7, ${PROXIED_IP}`,
      }).expect(401);

      expect(buckets()).toEqual([
        `${trustFly === 'true' ? FLY_IP : PROXIED_IP}|${SIGN_IN}`,
      ]);
    });

    it('falls back to the hops rule when Fly-Client-IP is not one IP', async () => {
      await signIn({
        'Fly-Client-IP': `${FLY_IP}, 198.51.100.21`,
        'X-Forwarded-For': PROXIED_IP,
      }).expect(401);

      expect(buckets()).toEqual([`${PROXIED_IP}|${SIGN_IN}`]);
    });
  },
);
