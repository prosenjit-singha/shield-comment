import { Body, Controller, Get, type INestApplication, Post, UseGuards } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { AuthGuard as BetterAuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { IsString } from 'class-validator';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { Database } from '../src/db/database.js';
import { users } from '../src/db/schema/index.js';
import { createTestApp, uniqueEmail } from './utils/create-test-app.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PASSWORD = 'correct-horse-battery';

class EchoDto {
  @IsString()
  message!: string;
}

/**
 * Test-only routes: probe the integration's guard + `@Session()` and the JSON parser that the
 * library re-adds for non-auth routes (Nest's own body parser is off).
 */
@Controller('spike')
class SpikeController {
  @Get('me')
  @UseGuards(BetterAuthGuard)
  me(@Session() session: UserSession) {
    return { userId: session.user.id, email: session.user.email };
  }

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
  return cookie!.split(';')[0]!;
}

describe('Better Auth (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;

  beforeAll(async () => {
    app = await createTestApp(undefined, [SpikeController]);
    db = app.get<Database>(getDrizzleToken());
  });

  afterAll(async () => {
    await app.close();
  });

  it('sign-up → sign-in → get-session', async () => {
    const email = uniqueEmail('ba');
    const server = app.getHttpServer();

    // Sign-up (mixed-case email to prove normalisation).
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send({ name: 'Rahim Uddin', email: email.toUpperCase(), password: PASSWORD })
      .expect(200);
    expect(signUp.body.user).toMatchObject({ name: 'Rahim Uddin', email, emailVerified: false });
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
    expect(account).toMatchObject({ providerId: 'credential', accountId: user!.id });
    expect(account!.id).toMatch(UUID_V7);
    expect(account!.password).toBeTruthy();
    expect(account!.password).not.toContain(PASSWORD);
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

    // The integration's guard + @Session() work on a NestJS 12 controller.
    await request(server)
      .get('/api/spike/me')
      .set('Cookie', cookie)
      .expect(200, { userId: user!.id, email });
  });

  it('get-session without a cookie returns null', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/get-session').expect(200);
    expect(res.body).toBeNull();
  });

  it('rejects a wrong password with 401', async () => {
    const email = uniqueEmail('ba-wrong');
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
    const email = uniqueEmail('ba-dup');
    const body = { name: 'Dup', email, password: PASSWORD };
    await request(app.getHttpServer()).post('/api/auth/sign-up/email').send(body).expect(200);
    const res = await request(app.getHttpServer()).post('/api/auth/sign-up/email').send(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('Better Auth guard returns 401 without a session', async () => {
    await request(app.getHttpServer()).get('/api/spike/me').expect(401);
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
    expect(bad.body).toMatchObject({ statusCode: 400, path: '/api/spike/echo' });
  });
});
