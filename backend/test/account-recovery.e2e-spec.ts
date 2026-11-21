import type { INestApplication } from '@nestjs/common';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { eq } from 'drizzle-orm';
import type request from 'supertest';
import type { App } from 'supertest/types.js';
import type { BetterAuth } from '../src/auth/better-auth.js';
import { sessions, users, workspaceMembers } from '../src/db/schema/index.js';
import { EmailService } from '../src/email/email.service.js';
import {
  createAuthActors,
  PASSWORD,
  sessionCookie,
  TRUSTED_ORIGIN,
} from './utils/auth-actors.js';
import { createTestApp, uniqueEmail } from './utils/create-test-app.js';
import {
  createEmailServiceFake,
  type FakeEmailService,
  linkToken,
} from './utils/fake-email.js';

const CLIENT_APP_URL = 'http://app.localhost:5174'; // vitest.config.e2e.ts
const NEW_PASSWORD = 'brand-new-password-9';
const RESET_REPLY = {
  status: true,
  message:
    'If this email exists in our system, check your email for the reset link',
};

/**
 * M9-T5 (D10 b, D2, M9-T5-a/b): forgot/reset password and required email verification through
 * Better Auth, emails through the strict `EmailService` fake (every send must be armed).
 */
describe('Password reset + email verification (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let email: FakeEmailService;
  let ip = 0;
  /** Own Better Auth / throttler bucket per test. */
  let clientIp: string;

  const post = (path: string, body: object, cookie?: string) => {
    const req = actors
      .http()
      .post(`/api/auth${path}`)
      .set('Origin', TRUSTED_ORIGIN)
      .set('X-Forwarded-For', clientIp);
    if (cookie) req.set('Cookie', cookie);
    return req.send(body);
  };
  const signIn = (to: string, password = PASSWORD) =>
    post('/sign-in/email', { email: to, password });
  const verify = (token: string) =>
    actors
      .http()
      .get('/api/auth/verify-email')
      .set('X-Forwarded-For', clientIp)
      .query({ token });
  const getSession = async (cookie: string) =>
    (
      await actors
        .http()
        .get('/api/auth/get-session')
        .set('Cookie', cookie)
        .expect(200)
    ).body as { session: { activeOrganizationId: string | null } } | null;
  const setCookies = (res: request.Response) =>
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

  /** Sign-up through the API like `/register`: one verification email, no session. */
  async function register(prefix: string) {
    const to = uniqueEmail(prefix);
    email.expectSends(1);
    const res = await post('/sign-up/email', {
      name: prefix,
      email: to,
      password: PASSWORD,
    }).expect(200);
    const id = res.body.user.id as string;
    actors.trackUser(id);
    const [member] = await actors.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, id));
    actors.trackWorkspace(member!.workspaceId);
    return { id, email: to, workspaceId: member!.workspaceId, res };
  }

  async function withRateLimit(fn: () => Promise<void>) {
    const auth = app.get<AuthService<BetterAuth>>(AuthService).instance;
    const context = await auth.$context;
    context.rateLimit.enabled = true;
    try {
      await fn();
    } finally {
      context.rateLimit.enabled = false;
    }
  }

  beforeAll(async () => {
    email = createEmailServiceFake();
    app = await createTestApp((b) =>
      b.overrideProvider(EmailService).useValue(email),
    );
    actors = createAuthActors(app);
  });

  beforeEach(() => {
    ip += 1;
    clientIp = `198.51.100.${ip}`;
  });

  afterEach(() => {
    expect(email.unexpected).toEqual([]);
    expect(email.pending).toBe(0);
    email.reset();
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('email verification (D10 b)', () => {
    it('sign-up: one bilingual email with the client /verify-email link, no session; sign-in refused until verified', async () => {
      const user = await register('m9t5-verify');
      expect(user.res.body.token).toBeNull();
      expect(user.res.body.user.emailVerified).toBe(false);
      expect(setCookies(user.res)).toEqual([]);
      expect(email.sent).toHaveLength(1);
      const [message] = email.sent;
      expect(message!.to).toBe(user.email);
      expect(message!.subject).toBe(
        'Confirm your email for ShieldComment BD · ShieldComment BD-এর জন্য আপনার ইমেইল নিশ্চিত করুন',
      );
      const token = linkToken(message!, '/verify-email');
      expect(message!.text).toContain(
        `Confirm email: ${CLIENT_APP_URL}/verify-email?token=`,
      );
      expect(message!.text).toContain(
        `ইমেইল নিশ্চিত করুন: ${CLIENT_APP_URL}/verify-email?token=`,
      );

      // Sign-in before verifying: 403, and no new email (no sendOnSignIn; the strict fake checks).
      const refused = await signIn(user.email).expect(403);
      expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect(setCookies(refused)).toEqual([]);

      // The link works once: it verifies and signs in, straight into the sign-up workspace.
      const first = await verify(token).expect(200);
      expect(first.body).toEqual({ status: true, user: null });
      const cookie = sessionCookie(first);
      expect((await getSession(cookie))?.session.activeOrganizationId).toBe(
        user.workspaceId,
      );
      const [row] = await actors.db
        .select({ emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, user.id));
      expect(row!.emailVerified).toBe(true);

      // A replay changes nothing and makes no session.
      const replay = await verify(token).expect(200);
      expect(replay.body).toEqual({ status: true, user: null });
      expect(
        setCookies(replay).filter((c) =>
          c.startsWith('better-auth.session_token='),
        ),
      ).toEqual([]);
      expect(
        await actors.db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, user.id)),
      ).toHaveLength(1);

      await signIn(user.email).expect(200);
    });

    it('a forged or garbage token → 401 INVALID_TOKEN, nothing verified', async () => {
      const user = await register('m9t5-forged');
      const res = await verify('not-a-jwt').expect(401);
      expect(res.body.code).toBe('INVALID_TOKEN');
      await signIn(user.email).expect(403);
    });

    it('resend: one new email for an unverified account; unknown or verified email → same 200, no email', async () => {
      const user = await register('m9t5-resend');
      email.reset();
      email.expectSends(1);
      const res = await post('/send-verification-email', {
        email: user.email,
      }).expect(200);
      expect(res.body).toEqual({ status: true });
      expect(email.sent).toHaveLength(1);
      await verify(linkToken(email.sent[0]!, '/verify-email')).expect(200);

      for (const to of [user.email, uniqueEmail('m9t5-nobody')]) {
        const quiet = await post('/send-verification-email', {
          email: to,
        }).expect(200);
        expect(quiet.body).toEqual({ status: true });
      }
      expect(email.sent).toHaveLength(1);
    });
  });

  describe('password reset (D10)', () => {
    it('request → one email with the client link; reset → every session gone, old password refused, new one works; the token works once', async () => {
      const user = await actors.signUp('m9t5-reset');
      const second = await actors.signIn(user.email);

      email.expectSends(1);
      const res = await post('/request-password-reset', {
        email: user.email,
      }).expect(200);
      expect(res.body).toEqual(RESET_REPLY);
      expect(email.sent).toHaveLength(1);
      const [message] = email.sent;
      expect(message!.to).toBe(user.email);
      expect(message!.subject).toBe(
        'Reset your ShieldComment BD password · আপনার ShieldComment BD পাসওয়ার্ড রিসেট করুন',
      );
      expect(message!.text).toContain(
        `Reset password: ${CLIENT_APP_URL}/reset-password?token=`,
      );
      const token = linkToken(message!, '/reset-password');
      expect(message!.html).toContain(
        `href="${CLIENT_APP_URL}/reset-password?token=${token}"`,
      );

      await post('/reset-password', {
        token,
        newPassword: NEW_PASSWORD,
      }).expect(200);
      expect(await getSession(user.cookie)).toBeNull();
      expect(await getSession(second)).toBeNull();
      expect(
        await actors.db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, user.id)),
      ).toEqual([]);
      await signIn(user.email).expect(401);
      await signIn(user.email, NEW_PASSWORD).expect(200);

      const reused = await post('/reset-password', {
        token,
        newPassword: 'third-password-77',
      }).expect(400);
      expect(reused.body.code).toBe('INVALID_TOKEN');
      await signIn(user.email, NEW_PASSWORD).expect(200);
    });

    it('an expired token → 400 INVALID_TOKEN, password unchanged', async () => {
      const user = await actors.signUp('m9t5-expired');
      email.expectSends(1);
      await post('/request-password-reset', { email: user.email }).expect(200);
      const token = linkToken(email.sent[0]!, '/reset-password');
      // Verification values live in secondary storage (Redis in the app): age this one by 1 h.
      const key = `verification:reset-password:${token}`;
      const stored = JSON.parse((await actors.storage.get(key)) as string) as {
        expiresAt: string;
      };
      stored.expiresAt = new Date(Date.now() - 1000).toISOString();
      await actors.storage.set(key, JSON.stringify(stored), 60);

      const res = await post('/reset-password', {
        token,
        newPassword: NEW_PASSWORD,
      }).expect(400);
      expect(res.body.code).toBe('INVALID_TOKEN');
      await signIn(user.email).expect(200);
      await signIn(user.email, NEW_PASSWORD).expect(401);
    });

    it('unknown email → the same 200 and no email', async () => {
      const res = await post('/request-password-reset', {
        email: uniqueEmail('m9t5-nobody'),
      }).expect(200);
      expect(res.body).toEqual(RESET_REPLY);
      expect(email.send).not.toHaveBeenCalled();
    });
  });

  it('rate limits (D2): request-password-reset, reset-password and send-verification-email allow 3 per minute per IP', async () => {
    await withRateLimit(async () => {
      const cases: [string, () => object, number][] = [
        [
          '/request-password-reset',
          () => ({ email: uniqueEmail('m9t5-rl') }),
          200,
        ],
        [
          '/reset-password',
          () => ({ token: 'nope', newPassword: NEW_PASSWORD }),
          400,
        ],
        [
          '/send-verification-email',
          () => ({ email: uniqueEmail('m9t5-rl') }),
          200,
        ],
      ];
      for (const [path, body, ok] of cases) {
        const statuses: number[] = [];
        for (let i = 0; i < 4; i += 1)
          statuses.push((await post(path, body())).status);
        expect(statuses, path).toEqual([ok, ok, ok, 429]);
      }
    });
  });

  it('M9-T5-b: a super admin may impersonate an unverified owner; the impersonated session is refused the reset and verification routes (403)', async () => {
    const owner = await register('m9t5-imp-owner');
    const superAdmin = await actors.signUpSuperAdmin('m9t5-imp-super');
    const issued = await actors
      .http()
      .post(`/api/admin/clients/${owner.workspaceId}/impersonate`)
      .set('Cookie', superAdmin.cookie)
      .expect(200);
    const exchanged = await post('/impersonate-exchange', {
      token: issued.body.token as string,
    }).expect(200);
    expect(exchanged.body.user).toMatchObject({ id: owner.id });
    const cookie = sessionCookie(exchanged);
    expect((await getSession(cookie))?.session.activeOrganizationId).toBe(
      owner.workspaceId,
    );

    for (const [path, body] of [
      ['/request-password-reset', { email: owner.email }],
      ['/reset-password', { token: 'x', newPassword: NEW_PASSWORD }],
      ['/send-verification-email', { email: owner.email }],
    ] as const) {
      const res = await post(path, body, cookie);
      expect(res.status, path).toBe(403);
      expect(res.body.message).toBe('Not allowed while impersonating');
    }
    const verifyAs = await actors
      .http()
      .get('/api/auth/verify-email')
      .set('Cookie', cookie)
      .query({ token: linkToken(email.sent[0]!, '/verify-email') });
    expect(verifyAs.status).toBe(403);
    const [row] = await actors.db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, owner.id));
    expect(row!.emailVerified).toBe(false);
  });
});
