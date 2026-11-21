import type { INestApplication } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { normalizeFeatureConfig } from '../src/admin/plan-rules.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import {
  plans,
  socialPages,
  subscriptions,
  walletBalances,
  wallets,
} from '../src/db/schema/index.js';
import { WalletService } from '../src/wallet/wallet.service.js';
import {
  type Actor,
  createAuthActors,
  TRUSTED_ORIGIN,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/**
 * PW-T6: the client `GET /api/workspaces/:workspaceId/billing/summary` (public `GET /api/plans`
 * moved to promotions.e2e-spec.ts with its PR-T2 shape)
 * (plan §3.7; user decisions 2026-11-19 PW-D5/D6 prices, PW-D9 paused, PW-D11 pooled). Real
 * Postgres; sign-ups have no plan (PR-T3): the owner starts the Starter trial explicitly. Pages are inserted directly with
 * real ciphertexts (the summary never reads them).
 */
describe('Billing summary (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  let wallet: WalletService;
  let owner: Actor;
  let moderator: Actor;
  let wsAdmin: Actor;
  let outsider: Actor;
  let superAdmin: Actor;
  const base = `7${Date.now()}`;
  let seq = 10;

  const http = () => request(app.getHttpServer());
  const db = () => actors.db;
  const summaryPath = (workspaceId: string) =>
    `/api/workspaces/${workspaceId}/billing/summary`;
  const summary = async (actor: Actor | string, workspaceId: string) =>
    (
      await http()
        .get(summaryPath(workspaceId))
        .set('Cookie', typeof actor === 'string' ? actor : actor.cookie)
        .expect(200)
    ).body as Record<string, unknown>;

  async function insertPage(workspaceId: string, isActive: boolean) {
    seq += 1;
    const pageId = `${base}${seq}`;
    await db()
      .insert(socialPages)
      .values({
        workspaceId,
        pageId,
        pageName: `Shop ${seq}`,
        encryptedPageAccessToken: cipher.encrypt(
          `EAApage${seq}x${base}`,
          tokenCipherContext('meta_page_token', workspaceId, pageId),
        ),
        isActive,
      });
  }

  const planRow = async (slug: string) => {
    const [row] = await db().select().from(plans).where(eq(plans.slug, slug));
    expect(row, `plan ${slug}`).toBeDefined();
    return {
      ...row!,
      limits: normalizeFeatureConfig(row!.featureConfig).limits,
    };
  };

  /** The owner's subscription with `status` (the live or the ended one). */
  const subscriptionOf = async (actor: Actor, status: string) => {
    const [row] = await db()
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.billingAccountId, await actors.accountIdOf(actor)),
          eq(subscriptions.status, status as 'ACTIVE'),
        ),
      );
    expect(row, `${status} subscription`).toBeDefined();
    return row!;
  };

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    wallet = app.get(WalletService);
    owner = await actors.signUp('pwt6-owner', { trial: true });
    moderator = await actors.signUp('pwt6-mod');
    wsAdmin = await actors.signUp('pwt6-admin');
    outsider = await actors.signUp('pwt6-outsider');
    superAdmin = await actors.signUpSuperAdmin('pwt6-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('GET …/billing/summary: auth + roles', () => {
    it('401 without a session', async () => {
      await http().get(summaryPath(owner.workspaceId)).expect(401);
    });

    it('owner, admin and moderator get 200 (any member), not cached', async () => {
      for (const actor of [owner, wsAdmin, moderator]) {
        const res = await http()
          .get(summaryPath(owner.workspaceId))
          .set('Cookie', actor.cookie)
          .expect(200);
        expect(res.headers['cache-control']).toBe('private, no-store');
        expect(res.body.status).toBe('TRIALING');
      }
    });

    it('404 for a non-member, an unknown workspace and a malformed id', async () => {
      await http()
        .get(summaryPath(owner.workspaceId))
        .set('Cookie', outsider.cookie)
        .expect(404);
      await http()
        .get(summaryPath('019a0000-0000-7000-8000-00000000dead'))
        .set('Cookie', owner.cookie)
        .expect(404);
      await http()
        .get(summaryPath('not-a-uuid'))
        .set('Cookie', owner.cookie)
        .expect(404);
    });

    it('an impersonated session reads its own workspace only (other ids 404)', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      expect((await summary(cookie, owner.workspaceId)).status).toBe(
        'TRIALING',
      );
      await http()
        .get(summaryPath(outsider.workspaceId))
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  describe('GET …/billing/summary: states', () => {
    it('trial: TRIALING Starter, trialEndsAt = termEndsAt = comments resetsAt, 0/300, workspaces 1/1, pages', async () => {
      const starter = await planRow('starter');
      const trial = await subscriptionOf(owner, 'TRIALING');
      expect(await summary(owner, owner.workspaceId)).toEqual({
        plan: { slug: 'starter', name: starter.name },
        interval: 'month',
        status: 'TRIALING',
        trialEndsAt: trial.trialEndsAt!.toISOString(),
        termEndsAt: trial.currentTermEnd.toISOString(),
        comments: {
          used: 0,
          limit: 300,
          resetsAt: trial.trialEndsAt!.toISOString(),
        },
        workspaces: { used: 1, limit: 1 },
        pages: { used: 0, limit: starter.limits.connectedPages },
        trialEligible: false,
        renewal: null,
        pendingPayment: null,
        scheduled: null,
        autoRenew: { available: false, enabled: false, tokenSaved: false },
      });
      expect(trial.trialEndsAt!.getTime()).toBe(trial.currentTermEnd.getTime());

      await insertPage(owner.workspaceId, true);
      await insertPage(owner.workspaceId, false);
      expect(
        await wallet.consume(owner.workspaceId, 'monthlyComments', 3),
      ).toBe('ok');
      const after = await summary(moderator, owner.workspaceId);
      expect(after.pages).toEqual({
        used: 1,
        limit: starter.limits.connectedPages,
      });
      expect(after.comments).toMatchObject({ used: 3, limit: 300 });
    });

    it('Growth with 2 workspaces: the same pooled numbers from both; wallet_balances.used reflected', async () => {
      const pool = await actors.signUp('pwt6-pool');
      const subId = await actors.activatePlan(pool, 'growth');
      const res = await http()
        .post('/api/auth/organization/create')
        .set('Cookie', pool.cookie)
        .set('Origin', TRUSTED_ORIGIN)
        .send({ name: 'PW-T6 second', slug: `pwt6-second-${Date.now()}` })
        .expect(200);
      const second = res.body.id as string;
      actors.trackWorkspace(second);
      await insertPage(pool.workspaceId, true);
      await insertPage(second, true);
      await insertPage(second, false);
      // Another account's Page never counts.
      await insertPage(outsider.workspaceId, true);
      expect(await wallet.consume(second, 'monthlyComments', 1)).toBe('ok');
      // `used` moved outside the API (e.g. the worker): the summary reads the stored counter.
      const walletIds = db()
        .select({ id: wallets.id })
        .from(wallets)
        .where(eq(wallets.billingAccountId, await actors.accountIdOf(pool)));
      await db()
        .update(walletBalances)
        .set({ used: 42 })
        .where(
          and(
            inArray(walletBalances.walletId, walletIds),
            eq(walletBalances.meter, 'monthlyComments'),
          ),
        );

      const growth = await planRow('growth');
      const [sub] = await db()
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subId));
      const fromFirst = await summary(pool, pool.workspaceId);
      const fromSecond = await summary(pool, second);
      expect(fromSecond).toEqual(fromFirst);
      expect(fromFirst).toMatchObject({
        plan: { slug: 'growth', name: growth.name },
        interval: 'month',
        status: 'ACTIVE',
        trialEndsAt: null,
        termEndsAt: sub!.currentTermEnd.toISOString(),
        comments: { used: 42, limit: growth.limits.monthlyComments },
        workspaces: { used: 2, limit: 3 },
        pages: { used: 2, limit: growth.limits.connectedPages },
      });
      const resetsAt = new Date(
        (fromFirst.comments as { resetsAt: string }).resetsAt,
      );
      expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
      expect(resetsAt.getTime()).toBeLessThanOrEqual(
        sub!.currentTermEnd.getTime(),
      );
    });

    it('expired trial: EXPIRED (paused) with the ended Starter + its trial end, comments 0/0, limits 0', async () => {
      const ended = await actors.signUp('pwt6-expired', { trial: true });
      const trial = await subscriptionOf(ended, 'TRIALING');
      await insertPage(ended.workspaceId, true);
      await actors.expirePlan(ended);
      expect(await summary(ended, ended.workspaceId)).toEqual({
        plan: { slug: 'starter', name: (await planRow('starter')).name },
        interval: 'month',
        status: 'EXPIRED',
        trialEndsAt: trial.trialEndsAt!.toISOString(),
        termEndsAt: trial.currentTermEnd.toISOString(),
        comments: { used: 0, limit: 0, resetsAt: null },
        workspaces: { used: 1, limit: 0 },
        pages: { used: 1, limit: 0 },
        trialEligible: false,
        renewal: null,
        pendingPayment: null,
        scheduled: null,
        autoRenew: { available: false, enabled: false, tokenSaved: false },
      });
    });

    it('a trial whose term is over but still TRIALING (expiry job not run) reads EXPIRED', async () => {
      const late = await actors.signUp('pwt6-late', { trial: true });
      const past = new Date(Date.now() - 60_000);
      await db()
        .update(subscriptions)
        .set({
          startedAt: new Date(past.getTime() - 3_600_000),
          currentTermStart: new Date(past.getTime() - 3_600_000),
          currentTermEnd: past,
          trialEndsAt: past,
        })
        .where(
          eq(subscriptions.billingAccountId, await actors.accountIdOf(late)),
        );
      expect(await summary(late, late.workspaceId)).toMatchObject({
        status: 'EXPIRED',
        trialEndsAt: past.toISOString(),
        comments: { used: 0, limit: 0, resetsAt: null },
      });
    });

    it('no billing account: NONE, plan/interval/dates null, this workspace only, limits 0', async () => {
      const orphan = await actors.signUp('pwt6-noaccount');
      await insertPage(orphan.workspaceId, true);
      await actors.removeBilling(orphan);
      expect(await summary(orphan, orphan.workspaceId)).toEqual({
        plan: null,
        interval: null,
        status: 'NONE',
        trialEndsAt: null,
        termEndsAt: null,
        comments: { used: 0, limit: 0, resetsAt: null },
        workspaces: { used: 1, limit: 0 },
        pages: { used: 1, limit: 0 },
        trialEligible: false,
        renewal: null,
        pendingPayment: null,
        scheduled: null,
        autoRenew: { available: false, enabled: false, tokenSaved: false },
      });
    });

    it('fresh sign-up (PR-T3): NONE, no plan, trialEligible true → false once the trial started', async () => {
      const fresh = await actors.signUp('prt3-fresh');
      expect(await summary(fresh, fresh.workspaceId)).toEqual({
        plan: null,
        interval: null,
        status: 'NONE',
        trialEndsAt: null,
        termEndsAt: null,
        comments: { used: 0, limit: 0, resetsAt: null },
        workspaces: { used: 1, limit: 0 },
        pages: { used: 0, limit: 0 },
        trialEligible: true,
        renewal: null,
        pendingPayment: null,
        scheduled: null,
        autoRenew: { available: false, enabled: false, tokenSaved: false },
      });
      await actors.startTrial(fresh);
      expect(await summary(fresh, fresh.workspaceId)).toMatchObject({
        status: 'TRIALING',
        trialEligible: false,
      });
      // Still false after the trial ended (one trial per account, reading 1).
      await actors.expirePlan(fresh);
      expect(await summary(fresh, fresh.workspaceId)).toMatchObject({
        status: 'EXPIRED',
        trialEligible: false,
      });
    });

    it('a paid plan that ended (never a trial): trialEligible true; while it is live: false', async () => {
      const paid = await actors.signUp('prt3-paid-summary');
      await actors.activatePlan(paid, 'growth');
      expect((await summary(paid, paid.workspaceId)).trialEligible).toBe(false);
      await actors.expirePlan(paid);
      expect((await summary(paid, paid.workspaceId)).trialEligible).toBe(true);
    });
  });
});
