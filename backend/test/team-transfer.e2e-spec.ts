import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  accounts,
  billingAccounts,
  subscriptions,
  workspaceMembers,
  workspaces,
} from '../src/db/schema/index.js';
import { EmailService } from '../src/email/email.service.js';
import { OwnershipTransferStore } from '../src/workspaces/ownership-transfer.store.js';
import {
  type Actor,
  createAuthActors,
  PASSWORD,
  TRUSTED_ORIGIN,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import {
  createEmailServiceFake,
  type FakeEmailService,
} from './utils/fake-email.js';
import { MemoryOwnershipTransferStore } from './utils/memory-transfer-store.js';

/**
 * M7-T6b (Module 7 D2, D11, M7-D19): `GET/POST /api/workspaces/:workspaceId/team/transfer-ownership`
 * (+ `/code`): password twice or an emailed code, roles swap, the billing account moves.
 */
describe('Team ownership transfer (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let email: FakeEmailService;
  const store = new MemoryOwnershipTransferStore();

  const url = (ws: string, suffix = '') =>
    `/api/workspaces/${ws}/team/transfer-ownership${suffix}`;
  const method = (cookie: string, ws: string) =>
    actors.http().get(url(ws)).set('Cookie', cookie);
  const sendCode = (cookie: string, ws: string) =>
    actors
      .http()
      .post(url(ws, '/code'))
      .set('Cookie', cookie)
      .set('Origin', TRUSTED_ORIGIN);
  const transfer = (cookie: string, ws: string, body: object) =>
    actors
      .http()
      .post(url(ws))
      .set('Cookie', cookie)
      .set('Origin', TRUSTED_ORIGIN)
      .send(body);
  const roleOf = async (userId: string, workspaceId: string) =>
    (
      await actors.db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, workspaceId),
          ),
        )
    )[0]?.role;
  const memberIdOf = async (userId: string, workspaceId: string) =>
    (
      await actors.db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, workspaceId),
          ),
        )
    )[0]!.id;
  const accountOwnerOf = async (accountId: string) =>
    (
      await actors.db
        .select({ owner: billingAccounts.ownerUserId })
        .from(billingAccounts)
        .where(eq(billingAccounts.id, accountId))
    )[0]?.owner;
  const passwordBody = (memberId: string, password = PASSWORD) => ({
    memberId,
    password,
    passwordConfirm: password,
  });

  /**
   * A Pro owner with an admin and a moderator. The admin has **no** billing account (like a user
   * who signed up from an invite), so the account can move to them.
   */
  const teamOf = async (tag: string) => {
    const owner = await actors.signUp(`m7t6b-${tag}`);
    await actors.activatePlan(owner, 'pro');
    const admin = await actors.signUp(`m7t6b-${tag}-admin`);
    const mod = await actors.signUp(`m7t6b-${tag}-mod`);
    await actors.removeBilling(admin);
    await actors.addMember(owner.workspaceId, admin.id, 'admin');
    await actors.addMember(owner.workspaceId, mod.id, 'moderator');
    return {
      owner,
      admin,
      mod,
      ws: owner.workspaceId,
      accountId: await actors.accountIdOf(owner),
      adminMember: await memberIdOf(admin.id, owner.workspaceId),
    };
  };
  /** Google-only owner: no `credential` account row (no password). */
  const dropPassword = (owner: Actor) =>
    actors.db
      .delete(accounts)
      .where(
        and(
          eq(accounts.userId, owner.id),
          eq(accounts.providerId, 'credential'),
        ),
      );
  const sentCode = () => {
    const match = /: (\d{6})\n/.exec(email.sent.at(-1)!.text);
    expect(match, 'code in the email').toBeTruthy();
    return match![1]!;
  };

  beforeAll(async () => {
    email = createEmailServiceFake();
    app = await createTestApp((b) =>
      b
        .overrideProvider(EmailService)
        .useValue(email)
        .overrideProvider(OwnershipTransferStore)
        .useValue(store),
    );
    actors = createAuthActors(app);
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

  it('password owner: method, mismatch 400, wrong 403, success → roles swapped, billing account moved, team view', async () => {
    const { owner, admin, ws, accountId, adminMember } = await teamOf('pw');
    const res = await method(owner.cookie, ws);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: 'password' });
    expect(res.headers['cache-control']).toBe('private, no-store');

    const missing = await transfer(owner.cookie, ws, { memberId: adminMember });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('TRANSFER_PASSWORD_REQUIRED');
    const mismatch = await transfer(owner.cookie, ws, {
      memberId: adminMember,
      password: PASSWORD,
      passwordConfirm: `${PASSWORD}x`,
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('TRANSFER_PASSWORD_MISMATCH');
    const wrong = await transfer(
      owner.cookie,
      ws,
      passwordBody(adminMember, 'not-the-password'),
    );
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('TRANSFER_PASSWORD_INVALID');
    const codeRoute = await sendCode(owner.cookie, ws);
    expect(codeRoute.status).toBe(409);
    expect(codeRoute.body.code).toBe('TRANSFER_CODE_NOT_NEEDED');

    const ok = await transfer(owner.cookie, ws, passwordBody(adminMember));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(
      ok.body.members.map((m: { userId: string; role: string }) => [
        m.userId,
        m.role,
      ]),
    ).toEqual([
      [admin.id, 'owner'],
      [owner.id, 'admin'],
      [expect.any(String), 'moderator'],
    ]);
    expect(await roleOf(admin.id, ws)).toBe('owner');
    expect(await roleOf(owner.id, ws)).toBe('admin');
    // Same account (plan, wallet, payments), new owner; the workspace stays linked.
    expect(await accountOwnerOf(accountId)).toBe(admin.id);
    const [link] = await actors.db
      .select({ accountId: workspaces.billingAccountId })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    expect(link!.accountId).toBe(accountId);
    expect(
      await actors.db
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.billingAccountId, accountId),
            eq(subscriptions.status, 'ACTIVE'),
          ),
        ),
    ).toHaveLength(1);

    // The old owner is an admin now: no more transfer.
    expect(
      (await transfer(owner.cookie, ws, passwordBody(adminMember))).status,
    ).toBe(403);
    expect((await method(admin.cookie, ws)).status).toBe(200);
  });

  it('M7-D19: target with an account in use → 409; empty account → deleted, then moved; other workspaces on the account → 409', async () => {
    const { owner, admin, mod, ws, accountId, adminMember } =
      await teamOf('d19');
    const modMember = await memberIdOf(mod.id, ws);
    // The moderator's sign-up account pays for their own workspace.
    const inUse = await transfer(owner.cookie, ws, passwordBody(modMember));
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('TRANSFER_TARGET_HAS_ACCOUNT');
    expect(await roleOf(owner.id, ws)).toBe('owner');

    // A second workspace on the owner's account.
    const [second] = await actors.db
      .insert(workspaces)
      .values({ name: 'Second', slug: `m7t6b-${crypto.randomUUID()}` })
      .returning({ id: workspaces.id });
    actors.trackWorkspace(second!.id);
    await actors.db
      .update(workspaces)
      .set({ billingAccountId: accountId })
      .where(eq(workspaces.id, second!.id));
    const others = await transfer(owner.cookie, ws, passwordBody(adminMember));
    expect(others.status).toBe(409);
    expect(others.body.code).toBe('TRANSFER_ACCOUNT_HAS_OTHER_WORKSPACES');
    await actors.db
      .update(workspaces)
      .set({ billingAccountId: null })
      .where(eq(workspaces.id, second!.id));

    const [empty] = await actors.db
      .insert(billingAccounts)
      .values({ ownerUserId: admin.id })
      .returning({ id: billingAccounts.id });
    const ok = await transfer(owner.cookie, ws, passwordBody(adminMember));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await accountOwnerOf(empty!.id)).toBeUndefined();
    expect(await accountOwnerOf(accountId)).toBe(admin.id);
  });

  it('Google-only owner: code emailed (en + bn) → resend 429 → wrong 403 → expired 403 → new code → success', async () => {
    const { owner, admin, ws, accountId, adminMember } = await teamOf('otp');
    await dropPassword(owner);
    expect((await method(owner.cookie, ws)).body).toEqual({ method: 'code' });

    const noCode = await transfer(owner.cookie, ws, { memberId: adminMember });
    expect(noCode.status).toBe(400);
    expect(noCode.body.code).toBe('TRANSFER_CODE_REQUIRED');

    email.expectSends(1);
    const sent = await sendCode(owner.cookie, ws);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toEqual({
      expiresAt: expect.any(String),
      resendAt: expect.any(String),
    });
    expect(email.sent[0]!.to).toBe(owner.email);
    expect(email.sent[0]!.subject).toContain('transfer workspace ownership');
    expect(email.sent[0]!.text).toContain('মালিকানা');
    expect(email.sent[0]!.text).not.toContain(ws);
    let code = sentCode();

    const again = await sendCode(owner.cookie, ws);
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('TRANSFER_CODE_RESEND_TOO_SOON');

    const wrongCode = code === '000000' ? '111111' : '000000';
    const wrong = await transfer(owner.cookie, ws, {
      memberId: adminMember,
      code: wrongCode,
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('TRANSFER_CODE_INVALID');

    store.expire(`ownership-transfer:${ws}:${owner.id}`);
    const expired = await transfer(owner.cookie, ws, {
      memberId: adminMember,
      code,
    });
    expect(expired.status).toBe(403);
    expect(expired.body.code).toBe('TRANSFER_CODE_EXPIRED');

    email.expectSends(1);
    expect((await sendCode(owner.cookie, ws)).status).toBe(200);
    code = sentCode();
    const ok = await transfer(owner.cookie, ws, {
      memberId: adminMember,
      code,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await roleOf(admin.id, ws)).toBe('owner');
    expect(await accountOwnerOf(accountId)).toBe(admin.id);
  });

  it('too many attempts → 429 and the code is dropped; email failure → 503, resend allowed', async () => {
    const { owner, ws, adminMember } = await teamOf('tries');
    await dropPassword(owner);
    email.expectSends(1);
    expect((await sendCode(owner.cookie, ws)).status).toBe(200);
    const code = sentCode();
    const wrongCode = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1)
      expect(
        (
          await transfer(owner.cookie, ws, {
            memberId: adminMember,
            code: wrongCode,
          })
        ).body.code,
      ).toBe('TRANSFER_CODE_INVALID');
    const blocked = await transfer(owner.cookie, ws, {
      memberId: adminMember,
      code,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('TRANSFER_TOO_MANY_ATTEMPTS');
    expect(await roleOf(owner.id, ws)).toBe('owner');

    store.expire(`ownership-transfer:${ws}:${owner.id}`);
    email.failNext(new Error('provider down'));
    const failed = await sendCode(owner.cookie, ws);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('TRANSFER_CODE_EMAIL_FAILED');
    email.expectSends(1);
    expect((await sendCode(owner.cookie, ws)).status).toBe(200);
  });

  it('admin/moderator 403; impersonated owner 403 IMPERSONATION_READ_ONLY (method still reads); not a member 404; self 400', async () => {
    const superAdmin = await actors.signUpSuperAdmin('m7t6b-super');
    const { owner, admin, mod, ws, adminMember } = await teamOf('guard');
    for (const who of [admin, mod]) {
      expect((await method(who.cookie, ws)).status).toBe(403);
      expect((await sendCode(who.cookie, ws)).status).toBe(403);
      expect(
        (await transfer(who.cookie, ws, passwordBody(adminMember))).status,
      ).toBe(403);
    }

    const ownerImp = await actors.signIn(owner.email);
    await actors.patchStoredSession(ownerImp, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: ws,
    });
    expect((await method(ownerImp, ws)).status).toBe(200);
    for (const res of [
      await sendCode(ownerImp, ws),
      await transfer(ownerImp, ws, passwordBody(adminMember)),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('IMPERSONATION_READ_ONLY');
    }

    const stranger = await actors.signUp('m7t6b-guard-stranger');
    const foreign = await transfer(
      owner.cookie,
      ws,
      passwordBody(await memberIdOf(stranger.id, stranger.workspaceId)),
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('TRANSFER_TARGET_NOT_FOUND');
    const self = await transfer(
      owner.cookie,
      ws,
      passwordBody(await memberIdOf(owner.id, ws)),
    );
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('TRANSFER_TARGET_IS_SELF');
    expect(await roleOf(owner.id, ws)).toBe('owner');
  });
});
