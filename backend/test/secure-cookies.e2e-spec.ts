import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createAuthActors, PASSWORD } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

// Before any import: ConfigModule validates (and caches) the env when AppModule is imported.
const { PUBLIC_URL, APP_ORIGIN } = vi.hoisted(() => {
  const urls = {
    PUBLIC_URL: 'https://api.shield.test',
    APP_ORIGIN: 'https://app.shield.test',
  };
  process.env.BETTER_AUTH_URL = urls.PUBLIC_URL;
  process.env.TRUSTED_ORIGINS = urls.APP_ORIGIN;
  return urls;
});

const UNKNOWN_ORIGIN = 'https://evil.example';
const COOKIE_NAME = '__Secure-better-auth.session_token';

/**
 * M9-T3 (D3, readings 3/4): session cookie flags under an https BETTER_AUTH_URL, Better Auth's
 * origin check, and CORS off unless CORS_ORIGINS is set.
 */
describe('strict origins + secure cookies (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;

  beforeAll(async () => {
    vi.stubEnv('CORS_ORIGINS', '');
    app = await createTestApp();
    vi.unstubAllEnvs();
    actors = createAuthActors(app);
  });

  afterAll(async () => {
    await actors.cleanup();
    await app.close();
  });

  it('runs on the https public URL', () => {
    expect(process.env.BETTER_AUTH_URL).toBe(PUBLIC_URL);
  });

  it('sign-in sets a __Secure- session cookie: HttpOnly, Secure, SameSite=Lax', async () => {
    const owner = await actors.signUp('secure-cookie');
    const res = await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .set('Origin', APP_ORIGIN)
      .send({ email: owner.email, password: PASSWORD })
      .expect(200);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
    expect(session, 'session cookie').toBeDefined();
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*Secure/i);
    expect(session).toMatch(/;\s*SameSite=Lax/i);
    // Every Better Auth cookie carries the prefix + flags (session data cache included).
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Secure-better-auth\./);
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/;\s*HttpOnly/i);
    }
  });

  it('refuses a Better Auth POST from an untrusted Origin (403)', async () => {
    const owner = await actors.signUp('untrusted-origin');
    await request(app.getHttpServer())
      .post('/api/auth/sign-out')
      .set('Cookie', owner.cookie)
      .set('Origin', UNKNOWN_ORIGIN)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .set('Origin', UNKNOWN_ORIGIN)
      .send({ email: owner.email, password: PASSWORD })
      .expect(403);
  });

  it.each([UNKNOWN_ORIGIN, APP_ORIGIN])(
    'CORS off without CORS_ORIGINS: preflight from %s gets no Access-Control-Allow-Origin',
    async (origin) => {
      const res = await request(app.getHttpServer())
        .options('/api/auth/sign-in/email')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    },
  );

  describe('with CORS_ORIGINS set', () => {
    let corsApp: INestApplication<App>;

    beforeAll(async () => {
      vi.stubEnv('CORS_ORIGINS', APP_ORIGIN);
      corsApp = await createTestApp();
      vi.unstubAllEnvs();
    });

    afterAll(async () => {
      await corsApp.close();
    });

    function preflight(origin: string) {
      return request(corsApp.getHttpServer())
        .options('/api/auth/sign-in/email')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST');
    }

    it('allows a listed origin with credentials', async () => {
      const res = await preflight(APP_ORIGIN).expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('gives an unknown origin no Access-Control-Allow-Origin', async () => {
      const res = await preflight(UNKNOWN_ORIGIN);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
