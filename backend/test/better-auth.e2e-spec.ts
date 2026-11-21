import {
  Body,
  Controller,
  Get,
  type INestApplication,
  Post,
} from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { IsString } from 'class-validator';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Public } from '../src/auth/decorators/public.decorator.js';
import type { Database } from '../src/db/database.js';
import {
  billingAccounts,
  users,
  workspaceMembers,
  workspaces,
} from '../src/db/schema/index.js';
import { AUTH_SECONDARY_STORAGE } from '../src/redis/redis-secondary-storage.js';
import { deleteBillingChildren } from './utils/auth-actors.js';
import { createTestApp, uniqueEmail } from './utils/create-test-app.js';
import type { createMemorySecondaryStorage } from './utils/memory-secondary-storage.js';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PASSWORD = 'correct-horse-battery';
/** PasswordService: argon2id, v19, OWASP baseline (19 MiB, 2 passes, 1 lane). */
const ARGON2ID_HASH =
  /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

class EchoDto {
  @IsString()
  message!: string;
}

/**
 * Test-only routes: probe the global session guard + `@Session()`, `@Public()`, and the JSON
 * parser that the library re-adds for non-auth routes (Nest's own body parser is off).
 */
@Controller('spike')
class SpikeController {
  /** No decorator: protected by the global guard. */
  @Get('me')
  me(@Session() session: UserSession) {
    return {
      userId: session.user.id,
      email: session.user.email,
      activeOrganizationId: session.session.activeOrganizationId,
    };
  }

  @Public()
  @Post('echo')
  echo(@Body() body: EchoDto) {
    return body;
  }
}

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('better-auth.session_token='));
  expect(cookie, 'session cookie').toBeDefined();
  expect(cookie).toMatch(/HttpOnly/i);
  // M9-T3: explicit Lax; no `Secure` while BETTER_AUTH_URL is http (secure-cookies.e2e-spec.ts).
  expect(cookie).toMatch(/SameSite=Lax/i);
  expect(cookie).not.toMatch(/;\s*Secure/i);
  return cookie!.split(';')[0]!;
}

describe('Better Auth (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let storage: ReturnType<typeof createMemorySecondaryStorage>;

  beforeAll(async () => {
    app = await createTestApp(undefined, [SpikeController]);
    db = app.get<Database>(getDrizzleToken());
    storage = app.get(AUTH_SECONDARY_STORAGE);
  });

  function signUp(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .send(body);
  }

  async function membershipsOf(email: string) {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      with: {
        memberships: { with: { workspace: true } },
        sessions: true,
        accounts: true,
      },
    });
    expect(user, `user ${email}`).toBeDefined();
    return user!;
  }

  /** Every email this spec signs up with; afterAll deletes those users and their workspaces. */
  const createdEmails: string[] = [];
  function trackedEmail(prefix: string): string {
    const email = uniqueEmail(prefix);
    createdEmails.push(email);
    return email;
  }

  afterAll(async () => {
    const ids = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.email, createdEmails))
    ).map((u) => u.id);
    if (ids.length) {
      const memberships = await db
        .select({ id: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(inArray(workspaceMembers.userId, ids));
      const workspaceIds = memberships.map((m) => m.id);
      // Sign-up billing (PW-T3): wallet rows + subscriptions first, accounts after workspaces.
      const accountIds = (
        await db
          .select({ id: billingAccounts.id })
          .from(billingAccounts)
          .where(inArray(billingAccounts.ownerUserId, ids))
      ).map((a) => a.id);
      await deleteBillingChildren(db, accountIds);
      if (workspaceIds.length)
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      if (accountIds.length)
        await db
          .delete(billingAccounts)
          .where(inArray(billingAccounts.id, accountIds));
      await db.delete(users).where(inArray(users.id, ids));
    }
    await app.close();
  });

  it('sign-up → sign-in → get-session', async () => {
    const email = trackedEmail('ba');
    const server = app.getHttpServer();

    // Sign-up (mixed-case email to prove normalisation).
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Rahim Uddin',
        email: email.toUpperCase(),
        password: PASSWORD,
      })
      .expect(200);
    expect(signUp.body.user).toMatchObject({
      name: 'Rahim Uddin',
      email,
      emailVerified: false,
    });
    expect(signUp.body.user.id).toMatch(UUID_V7);
    sessionCookie(signUp);

    // Rows land in our snake_case tables with UUIDv7 ids; the password is hashed in `accounts`.
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      with: { accounts: true, sessions: true },
    });
    expect(user).toBeDefined();
    expect(user!.id).toBe(signUp.body.user.id);
    expect(user!.accounts).toHaveLength(1);
    const [account] = user!.accounts;
    expect(account).toMatchObject({
      providerId: 'credential',
      accountId: user!.id,
    });
    expect(account!.id).toMatch(UUID_V7);
    expect(account!.password).toMatch(ARGON2ID_HASH);
    expect(user!.sessions).toHaveLength(1);
    expect(user!.sessions[0]!.id).toMatch(UUID_V7);

    // Sign-in.
    const signIn = await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email, password: PASSWORD })
      .expect(200);
    expect(signIn.body.user).toMatchObject({ id: user!.id, email });
    const cookie = sessionCookie(signIn);

    // Get-session with the cookie.
    const session = await request(server)
      .get('/api/auth/get-session')
      .set('Cookie', cookie)
      .expect(200);
    expect(session.body.user).toMatchObject({ id: user!.id, email });
    expect(session.body.session).toMatchObject({ userId: user!.id });

    // The global guard + @Session() work on a NestJS 12 controller.
    const me = await request(server)
      .get('/api/spike/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(me.body).toMatchObject({ userId: user!.id, email });
  });

  it('sign-up creates the first workspace with the user as owner and makes it active', async () => {
    const email = trackedEmail('ba-ws');
    const res = await signUp({
      name: 'Rahim Uddin',
      email,
      password: PASSWORD,
    }).expect(200);
    expect(res.body.user.role).toBe('user');

    const user = await membershipsOf(email);
    expect(user.role).toBe('user');
    expect(user.banned).toBe(false);
    expect(user.memberships).toHaveLength(1);
    const [membership] = user.memberships;
    expect(membership).toMatchObject({ role: 'owner', userId: user.id });
    expect(membership!.workspace).toMatchObject({
      name: "Rahim Uddin's workspace",
      status: 'ACTIVE',
    });
    expect(membership!.workspace.id).toMatch(UUID_V7);
    expect(membership!.workspace.slug).toMatch(
      /^rahim-uddin-s-workspace-[0-9a-f]{6}$/,
    );
    // The sign-up session already points at it (DB row, get-session and the guard's session).
    expect(user.sessions[0]!.activeOrganizationId).toBe(
      membership!.workspaceId,
    );
    const cookie = sessionCookie(res);
    const session = await request(app.getHttpServer())
      .get('/api/auth/get-session')
      .set('Cookie', cookie)
      .expect(200);
    expect(session.body.session.activeOrganizationId).toBe(
      membership!.workspaceId,
    );

    // The organization plugin reads the renamed tables.
    const list = await request(app.getHttpServer())
      .get('/api/auth/organization/list')
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id: membership!.workspaceId,
        status: 'ACTIVE',
      }),
    ]);

    // Sign-in reuses it (no second workspace) and starts the new session in it.
    const signIn = await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .send({ email, password: PASSWORD })
      .expect(200);
    const me = await request(app.getHttpServer())
      .get('/api/spike/me')
      .set('Cookie', sessionCookie(signIn))
      .expect(200);
    expect(me.body.activeOrganizationId).toBe(membership!.workspaceId);
    expect((await membershipsOf(email)).memberships).toHaveLength(1);
  });

  it('uses workspaceName from the sign-up body and rejects an invalid one', async () => {
    const email = trackedEmail('ba-wsname');
    await signUp({
      name: 'Karim',
      email,
      password: PASSWORD,
      workspaceName: '  Dhaka Fashion  ',
    }).expect(200);
    const user = await membershipsOf(email);
    expect(user.memberships[0]!.workspace.name).toBe('Dhaka Fashion');
    expect(user.memberships[0]!.workspace.slug).toMatch(
      /^dhaka-fashion-[0-9a-f]{6}$/,
    );

    const bad = trackedEmail('ba-wsbad');
    await signUp({
      name: 'Bad',
      email: bad,
      password: PASSWORD,
      workspaceName: 'x'.repeat(81),
    }).expect(400);
    await signUp({
      name: 'Bad',
      email: bad,
      password: PASSWORD,
      workspaceName: '   ',
    }).expect(400);
    expect(
      await db.query.users.findFirst({ where: eq(users.email, bad) }),
    ).toBeUndefined();
  });

  it('does not let sign-up set role, banned or workspace status', async () => {
    const email = trackedEmail('ba-role');
    const res = await signUp({
      name: 'Sneaky',
      email,
      password: PASSWORD,
      role: 'super_admin',
    });
    expect(res.status).toBe(400);
    expect(
      await db.query.users.findFirst({ where: eq(users.email, email) }),
    ).toBeUndefined();
  });

  it('keeps sessions in Postgres and caches them in secondary storage', async () => {
    const email = trackedEmail('ba-cache');
    const res = await signUp({
      name: 'Cache',
      email,
      password: PASSWORD,
    }).expect(200);
    const token = decodeURIComponent(sessionCookie(res).split('=')[1]!).split(
      '.',
    )[0]!;
    const user = await membershipsOf(email);
    expect(user.sessions.map((s) => s.token)).toContain(token);
    expect(storage.keys()).toContain(token);
  });

  it('get-session without a cookie returns null', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/get-session')
      .expect(200);
    expect(res.body).toBeNull();
  });

  it('rejects a wrong password with 401', async () => {
    const email = trackedEmail('ba-wrong');
    await request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .send({ name: 'Karim', email, password: PASSWORD })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .send({ email, password: 'not-the-password' })
      .expect(401);
  });

  it('rejects a duplicate sign-up', async () => {
    const email = trackedEmail('ba-dup');
    const body = { name: 'Dup', email, password: PASSWORD };
    await request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .send(body)
      .expect(200);
    const res = await request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .send(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('global guard: 401 without a session, @Public() routes stay open', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/spike/me')
      .expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, path: '/api/spike/me' });
    await request(app.getHttpServer())
      .get('/api/spike/me')
      .set('Cookie', 'better-auth.session_token=forged.value')
      .expect(401);
    const health = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(health.body).toMatchObject({ status: 'ok' });
  });

  it('non-auth routes still parse JSON and run the ValidationPipe', async () => {
    await request(app.getHttpServer())
      .post('/api/spike/echo')
      .send({ message: 'hello' })
      .expect(201, { message: 'hello' });
    const bad = await request(app.getHttpServer())
      .post('/api/spike/echo')
      .send({ message: 'hello', extra: 1 })
      .expect(400);
    expect(bad.body).toMatchObject({
      statusCode: 400,
      path: '/api/spike/echo',
    });
  });
});
