import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { BillingJobSchedulers } from '../src/billing/billing-job-schedulers.js';
import { SUBSCRIPTION_EXPIRY_JOB_NAME } from '../src/billing/billing-scheduled.jobs.js';
import { BillingProcessor } from '../src/billing/billing.processor.js';
import { SubscriptionService } from '../src/billing/subscription.service.js';
import type { Database } from '../src/db/database.js';
import {
  billingAccounts,
  plans,
  promotionPlans,
  promotionRedemptions,
  promotions,
  subscriptions,
  walletBalances,
  walletEntries,
  wallets,
  workspaceMembers,
  workspaces,
} from '../src/db/schema/index.js';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
} from '../src/queue/queue.constants.js';
import { WalletService } from '../src/wallet/wallet.service.js';
import {
  type Actor,
  createAuthActors,
  deleteBillingChildren,
  TRUSTED_ORIGIN,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { addDroppedPlanColumns } from './utils/dropped-plan-columns.js';
import { fakeQueue } from './utils/fake-queue.js';

const DAY = 86_400_000;
const BACKFILL_MIGRATION = new URL(
  '../drizzle/0023_billing_account_trial_backfill.sql',
  import.meta.url,
);

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

/**
 * PW-T3 accounts + expiry (PW-D9, PW-D15 backfill) and PR-T3 trial by choice (user decisions
 * 2026-11-20 PR-D3, PR-D10: no trial at sign-up, `POST …/billing/trial` from a live TRIAL
 * promotion; reading 1: one trial per account ever). Real Postgres; the seeded "Starter 7-day
 * trial" (7 days / 300 comments, 0027) is the default trial; the Starter plan's old trial columns
 * (0022, still read by the 0023 backfill) are restored after the tests that change them.
 */
describe('Subscriptions + trial by choice (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let service: SubscriptionService;
  let wallet: WalletService;
  let starterId: string;
  let growthId: string;
  let proId: string;

  const db = (): Database => actors.db;

  const accountOf = async (userId: string, ex: Executor = db()) =>
    (
      await ex
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.ownerUserId, userId))
    )[0];

  const linkOf = async (workspaceId: string, ex: Executor = db()) =>
    (
      await ex
        .select({ billingAccountId: workspaces.billingAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
    )[0]?.billingAccountId;

  const subsOf = (accountId: string, ex: Executor = db()) =>
    ex
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.billingAccountId, accountId))
      .orderBy(asc(subscriptions.createdAt));

  const walletOf = async (accountId: string, ex: Executor = db()) =>
    (
      await ex
        .select()
        .from(wallets)
        .where(eq(wallets.billingAccountId, accountId))
    )[0];

  const balancesOf = (accountId: string, ex: Executor = db()) =>
    ex
      .select({
        meter: walletBalances.meter,
        periodStart: walletBalances.periodStart,
        periodEnd: walletBalances.periodEnd,
        included: walletBalances.included,
        added: walletBalances.added,
        used: walletBalances.used,
      })
      .from(walletBalances)
      .innerJoin(wallets, eq(wallets.id, walletBalances.walletId))
      .where(eq(wallets.billingAccountId, accountId));

  const entriesOf = (accountId: string, ex: Executor = db()) =>
    ex
      .select({
        meter: walletEntries.meter,
        periodStart: walletEntries.periodStart,
        kind: walletEntries.kind,
        amount: walletEntries.amount,
        reference: walletEntries.reference,
        actorUserId: walletEntries.actorUserId,
      })
      .from(walletEntries)
      .innerJoin(wallets, eq(wallets.id, walletEntries.walletId))
      .where(eq(wallets.billingAccountId, accountId));

  const redemptionsOf = (accountId: string) =>
    db()
      .select()
      .from(promotionRedemptions)
      .where(eq(promotionRedemptions.billingAccountId, accountId));

  /** The seeded "Starter 7-day trial" (0027, `created_by` null). */
  const seedTrialId = async () =>
    (
      await db()
        .select({ id: promotions.id })
        .from(promotions)
        .innerJoin(
          promotionPlans,
          eq(promotionPlans.promotionId, promotions.id),
        )
        .where(
          and(
            eq(promotions.kind, 'TRIAL'),
            eq(promotionPlans.planId, starterId),
            isNull(promotions.createdBy),
          ),
        )
    )[0]!.id;

  /** Everything a new trial writes, checked against the given trial values. */
  async function expectFreshTrial(
    actor: Actor,
    days: number,
    grant: number,
    ex: Executor = db(),
    planId = starterId,
  ) {
    const account = await accountOf(actor.id, ex);
    expect(account, 'billing account').toBeDefined();
    expect(await linkOf(actor.workspaceId, ex)).toBe(account!.id);
    const subs = await subsOf(account!.id, ex);
    expect(subs).toHaveLength(1);
    const sub = subs[0]!;
    expect(sub).toMatchObject({
      planId,
      interval: 'month',
      status: 'TRIALING',
      pricePerMonthBdt: null,
      chargedBdt: null,
      canceledAt: null,
    });
    expect(sub.currentTermStart).toEqual(sub.startedAt);
    expect(sub.trialEndsAt).toEqual(sub.currentTermEnd);
    expect(sub.currentTermEnd.getTime() - sub.startedAt.getTime()).toBe(
      days * DAY,
    );
    const w = await walletOf(account!.id, ex);
    expect(w).toMatchObject({
      cycleAnchorAt: sub.startedAt,
      currentPeriodStart: sub.startedAt,
      currentPeriodEnd: sub.currentTermEnd,
    });
    expect(await balancesOf(account!.id, ex)).toEqual([
      {
        meter: 'monthlyComments',
        periodStart: sub.startedAt,
        periodEnd: sub.currentTermEnd,
        included: grant,
        added: 0,
        used: 0,
      },
    ]);
    expect(await entriesOf(account!.id, ex)).toEqual([
      {
        meter: 'monthlyComments',
        periodStart: sub.startedAt,
        kind: 'PLAN_GRANT',
        amount: grant,
        reference: sub.id,
        actorUserId: null,
      },
    ]);
    return { account: account!, sub };
  }

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    service = app.get(SubscriptionService);
    wallet = app.get(WalletService);
    const idOf = async (slug: string) =>
      (
        await db()
          .select({ id: plans.id })
          .from(plans)
          .where(eq(plans.slug, slug))
      )[0]!.id;
    starterId = await idOf('starter');
    growthId = await idOf('growth');
    proId = await idOf('pro');
  });

  afterAll(async () => {
    if (actors) {
      await actors.cleanup();
    }
    await app?.close();
  });

  describe('sign-up (PR-T3: no plan)', () => {
    it('creates the account and links the workspace, no subscription, no wallet; set up at once (no repair loop)', async () => {
      const owner = await actors.signUp('pwt3-signup');
      const account = (await accountOf(owner.id))!;
      expect(account.ownerUserId).toBe(owner.id);
      expect(await linkOf(owner.workspaceId)).toBe(account.id);
      expect(await subsOf(account.id)).toEqual([]);
      expect(await walletOf(account.id)).toBeUndefined();
      expect(await service.activePlan(owner.workspaceId)).toBeNull();
      expect(await wallet.consume(owner.workspaceId, 'monthlyComments')).toBe(
        'no_active_plan',
      );
      expect(await service.isSetUp(owner.workspaceId)).toBe(true);
      // A later session create finds nothing to repair and starts nothing.
      await actors.signIn(owner.email);
      expect(await subsOf(account.id)).toEqual([]);
      expect(await redemptionsOf(account.id)).toEqual([]);
    });
  });

  describe('POST …/billing/trial (PR-T3)', () => {
    let creator: Actor;
    const trialPath = (workspaceId: string) =>
      `/api/workspaces/${workspaceId}/billing/trial`;
    const post = (actor: Actor | string, workspaceId: string, body: object) =>
      actors
        .http()
        .post(trialPath(workspaceId))
        .set('Cookie', typeof actor === 'string' ? actor : actor.cookie)
        .send(body);
    const start = (owner: Actor, planId = starterId) =>
      post(owner, owner.workspaceId, { planId });

    /** A TRIAL promotion made by `creator` (deleted by `cleanup()`). */
    async function insertTrial(
      planId: string,
      patch: Partial<typeof promotions.$inferInsert> = {},
    ): Promise<string> {
      const [row] = await db()
        .insert(promotions)
        .values({
          kind: 'TRIAL',
          name: 'PR-T3 trial',
          trialDays: 3,
          createdBy: creator.id,
          ...patch,
        })
        .returning({ id: promotions.id });
      await db()
        .insert(promotionPlans)
        .values({ promotionId: row!.id, planId });
      return row!.id;
    }

    beforeAll(async () => {
      creator = await actors.signUp('prt3-creator');
    });

    it('owner: 201 + summary; TRIALING 7-day Starter, redemption linked, wallet 300 from the promotion snapshot', async () => {
      const owner = await actors.signUp('prt3-happy');
      const before = Date.now();
      const res = await start(owner);
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body).toMatchObject({
        plan: { slug: 'starter' },
        status: 'TRIALING',
        comments: { used: 0, limit: 300 },
        trialEligible: false,
      });
      const { account, sub } = await expectFreshTrial(owner, 7, 300);
      expect(sub.startedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(res.body.trialEndsAt).toBe(sub.trialEndsAt!.toISOString());
      const [redemption, ...more] = await redemptionsOf(account.id);
      expect(more).toEqual([]);
      expect(redemption).toMatchObject({
        promotionId: await seedTrialId(),
        subscriptionId: sub.id,
        kind: 'TRIAL',
        trialDays: 7,
        trialCommentLimit: 300,
        discountBdtFirstTerm: 0,
      });
      expect(sub.promotionRedemptionId).toBe(redemption!.id);
      expect(await service.activePlan(owner.workspaceId)).toMatchObject({
        status: 'TRIALING',
        plan: { slug: 'starter', trialCommentLimit: 300 },
      });
      expect(await wallet.consume(owner.workspaceId, 'monthlyComments')).toBe(
        'ok',
      );
    });

    it('a promotion without a comment limit grants the plan’s monthly comments; its days, not the plan’s', async () => {
      const owner = await actors.signUp('prt3-fallback');
      await insertTrial(growthId, { trialDays: 3, trialCommentLimit: null });
      await start(owner, growthId).expect(201);
      const [plan] = await db()
        .select({ featureConfig: plans.featureConfig })
        .from(plans)
        .where(eq(plans.id, growthId));
      await expectFreshTrial(
        owner,
        3,
        plan!.featureConfig.limits.monthlyComments,
        db(),
        growthId,
      );
      expect(await wallet.balance(owner.workspaceId)).toMatchObject({
        included: plan!.featureConfig.limits.monthlyComments,
      });
    });

    it('401 without a session, 404 for a non-member, 403 for admin + moderator, 403 impersonated; nothing written', async () => {
      const owner = await actors.signUp('prt3-roles');
      const admin = await actors.signUp('prt3-roles-admin');
      const mod = await actors.signUp('prt3-roles-mod');
      await actors.addMember(owner.workspaceId, admin.id, 'admin');
      await actors.addMember(owner.workspaceId, mod.id, 'moderator');
      await actors
        .http()
        .post(trialPath(owner.workspaceId))
        .send({ planId: starterId })
        .expect(401);
      await post(creator, owner.workspaceId, { planId: starterId }).expect(404);
      for (const member of [admin, mod])
        await post(member, owner.workspaceId, { planId: starterId }).expect(
          403,
        );
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: creator.id,
        activeOrganizationId: owner.workspaceId,
      });
      const res = await post(cookie, owner.workspaceId, {
        planId: starterId,
      }).expect(403);
      expect(res.body.message).toMatch(/impersonat/i);
      expect(await subsOf((await accountOf(owner.id))!.id)).toEqual([]);
    });

    it('400 for a bad body, PLAN_NOT_AVAILABLE for an unknown or inactive plan', async () => {
      const owner = await actors.signUp('prt3-body');
      await post(owner, owner.workspaceId, { planId: 'nope' }).expect(400);
      await post(owner, owner.workspaceId, {}).expect(400);
      await post(owner, owner.workspaceId, {
        planId: starterId,
        extra: 1,
      }).expect(400);
      const [free] = await db()
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.slug, 'free'));
      for (const planId of ['019a0000-0000-7000-8000-00000000beef', free!.id]) {
        const res = await start(owner, planId).expect(400);
        expect(res.body.code).toBe('PLAN_NOT_AVAILABLE');
      }
    });

    it('TRIAL_NOT_AVAILABLE: plan not targeted, the trial stopped, ended or used up', async () => {
      const owner = await actors.signUp('prt3-none');
      const code = async (planId: string) =>
        (await start(owner, planId).expect(409)).body.code as string;
      // Pro has no trial promotion.
      expect(await code(proId)).toBe('TRIAL_NOT_AVAILABLE');
      await insertTrial(proId, { endsAt: new Date(Date.now() - 60_000) });
      expect(await code(proId)).toBe('TRIAL_NOT_AVAILABLE');
      // Used up ("first N" cap reached by another account).
      const capped = await insertTrial(proId, { maxRedemptions: 1 });
      await db()
        .insert(promotionRedemptions)
        .values({
          promotionId: capped,
          billingAccountId: (await accountOf(creator.id))!.id,
          kind: 'TRIAL',
          trialDays: 3,
        });
      expect(await code(proId)).toBe('TRIAL_NOT_AVAILABLE');
      const seed = await seedTrialId();
      try {
        await db()
          .update(promotions)
          .set({ stoppedAt: new Date(), stoppedBy: creator.id })
          .where(eq(promotions.id, seed));
        expect(await code(starterId)).toBe('TRIAL_NOT_AVAILABLE');
      } finally {
        await db()
          .update(promotions)
          .set({ stoppedAt: null, stoppedBy: null })
          .where(eq(promotions.id, seed));
      }
      expect(await subsOf((await accountOf(owner.id))!.id)).toEqual([]);
    });

    it('one trial per account ever: a second (other promotion) → TRIAL_ALREADY_USED; a live plan → PLAN_ALREADY_ACTIVE', async () => {
      const owner = await actors.signUp('prt3-twice', { trial: true });
      let res = await start(owner).expect(409);
      expect(res.body.code).toBe('PLAN_ALREADY_ACTIVE');
      await actors.expirePlan(owner);
      await insertTrial(growthId);
      res = await start(owner, growthId).expect(409);
      expect(res.body.code).toBe('TRIAL_ALREADY_USED');

      const paid = await actors.signUp('prt3-paid');
      await actors.activatePlan(paid, 'growth');
      res = await start(paid).expect(409);
      expect(res.body.code).toBe('PLAN_ALREADY_ACTIVE');
      const account = (await accountOf(owner.id))!.id;
      expect((await subsOf(account)).map((s) => s.status)).toEqual(['EXPIRED']);
      expect(await redemptionsOf(account)).toHaveLength(1);
    });

    it('an old sign-up trial (no redemption row) counts: TRIAL_ALREADY_USED, trialEligible false', async () => {
      const owner = await actors.signUp('prt3-legacy');
      const summary = async () =>
        (
          await actors
            .http()
            .get(`/api/workspaces/${owner.workspaceId}/billing/summary`)
            .set('Cookie', owner.cookie)
            .expect(200)
        ).body as { trialEligible: boolean; status: string };
      expect(await summary()).toMatchObject({
        status: 'NONE',
        trialEligible: true,
      });
      const startedAt = new Date(Date.now() - 10 * DAY);
      const end = new Date(Date.now() - 3 * DAY);
      await db()
        .insert(subscriptions)
        .values({
          billingAccountId: (await accountOf(owner.id))!.id,
          planId: starterId,
          interval: 'month',
          status: 'EXPIRED',
          startedAt,
          trialEndsAt: end,
          currentTermStart: startedAt,
          currentTermEnd: end,
        });
      expect(await summary()).toMatchObject({
        status: 'EXPIRED',
        trialEligible: false,
      });
      const res = await start(owner).expect(409);
      expect(res.body.code).toBe('TRIAL_ALREADY_USED');
    });

    it('a stale paid row past its term (expiry job not run) is recorded EXPIRED and the trial starts', async () => {
      const owner = await actors.signUp('prt3-stale');
      const subId = await actors.activatePlan(owner, 'growth');
      const past = new Date(Date.now() - 60_000);
      await db()
        .update(subscriptions)
        .set({
          startedAt: new Date(past.getTime() - 30 * DAY),
          currentTermStart: new Date(past.getTime() - 30 * DAY),
          currentTermEnd: past,
        })
        .where(eq(subscriptions.id, subId));
      await start(owner).expect(201);
      const account = (await accountOf(owner.id))!.id;
      expect(
        (await subsOf(account)).map((s) => [s.id === subId, s.status]),
      ).toEqual([
        [true, 'EXPIRED'],
        [false, 'TRIALING'],
      ]);
    });

    it('NO_BILLING_ACCOUNT when the workspace has no account', async () => {
      const owner = await actors.signUp('prt3-orphan');
      await actors.removeBilling(owner);
      const res = await start(owner).expect(409);
      expect(res.body.code).toBe('NO_BILLING_ACCOUNT');
    });

    it('a parallel double-click starts exactly one trial (one redemption, one grant)', async () => {
      const owner = await actors.signUp('prt3-race');
      const statuses = (
        await Promise.all([1, 2, 3].map(() => start(owner)))
      ).map((r) => r.status);
      expect(statuses.sort((x, y) => x - y)).toEqual([201, 409, 409]);
      const account = (await accountOf(owner.id))!.id;
      expect(await subsOf(account)).toHaveLength(1);
      expect(await redemptionsOf(account)).toHaveLength(1);
      expect(await balancesOf(account)).toHaveLength(1);
      expect(await entriesOf(account)).toHaveLength(1);
    });
  });

  describe('repair on the next session create', () => {
    it('an owner whose workspace has no account gets account + link (no plan) at sign-in, once', async () => {
      const owner = await actors.signUp('pwt3-repair');
      await actors.removeBilling(owner);
      expect(await accountOf(owner.id)).toBeUndefined();
      expect(await linkOf(owner.workspaceId)).toBeNull();
      expect(await service.isSetUp(owner.workspaceId)).toBe(false);
      await actors.signIn(owner.email);
      const account = (await accountOf(owner.id))!;
      expect(await linkOf(owner.workspaceId)).toBe(account.id);
      expect(await subsOf(account.id)).toEqual([]);
      expect(await service.isSetUp(owner.workspaceId)).toBe(true);
      // Already set up: another sign-in changes nothing.
      await actors.signIn(owner.email);
      expect((await accountOf(owner.id))!.id).toBe(account.id);
    });

    it('a non-owner member is never set up by a sign-in', async () => {
      const owner = await actors.signUp('pwt3-host');
      const guest = await actors.signUp('pwt3-guest');
      await actors.removeBilling(guest);
      // Make the guest's oldest membership a moderator seat in the owner's workspace.
      await db()
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.userId, guest.id));
      await actors.addMember(owner.workspaceId, guest.id, 'moderator');
      await actors.signIn(guest.email);
      expect(await accountOf(guest.id)).toBeUndefined();
    });
  });

  describe('/organization/create', () => {
    it('links the new workspace to the creator account, no second trial', async () => {
      const owner = await actors.signUp('pwt3-second', { trial: true });
      const account = (await accountOf(owner.id))!;
      // Starter allows 1 workspace (PW-T5): a paid Growth term (3) makes room for the second.
      await actors.activatePlan(owner, 'growth');
      const res = await actors
        .http()
        .post('/api/auth/organization/create')
        .set('Cookie', owner.cookie)
        .set('Origin', TRUSTED_ORIGIN)
        .send({ name: 'Second shop', slug: `pwt3-second-${Date.now()}` })
        .expect(200);
      const workspaceId = res.body.id as string;
      actors.trackWorkspace(workspaceId);
      expect(workspaceId).not.toBe(owner.workspaceId);
      expect(await linkOf(workspaceId)).toBe(account.id);
      // The ended trial + the Growth term: no second trial was started.
      expect((await subsOf(account.id)).map((sub) => sub.status)).toEqual([
        'EXPIRED',
        'ACTIVE',
      ]);
      // Pooled: both workspaces see the same live plan and wallet.
      const [first, second] = await Promise.all([
        service.activePlan(owner.workspaceId),
        service.activePlan(workspaceId),
      ]);
      expect(second?.subscriptionId).toBe(first?.subscriptionId);
    });
  });

  describe('expiry', () => {
    it('expireDue marks due live rows EXPIRED, leaves the rest; readers stop at the term end before the job', async () => {
      // Flush anything already due so the counts below are this test's own.
      await service.expireDue();
      // T is in the past: every other trial of this spec ends after it, so only ours are due.
      const T = new Date(Math.floor(Date.now() / 1000) * 1000 - DAY);
      const due = await actors.signUp('pwt3-due', { trial: true });
      const boundary = await actors.signUp('pwt3-boundary', { trial: true });
      const later = await actors.signUp('pwt3-later', { trial: true });
      const canceled = await actors.signUp('pwt3-canceled', { trial: true });
      const accountId = async (a: Actor) => (await accountOf(a.id))!.id;
      const setTrial = async (a: Actor, start: Date, end: Date) =>
        db()
          .update(subscriptions)
          .set({
            startedAt: start,
            currentTermStart: start,
            trialEndsAt: end,
            currentTermEnd: end,
          })
          .where(eq(subscriptions.billingAccountId, await accountId(a)));
      await setTrial(
        due,
        new Date(T.getTime() - 10 * DAY),
        new Date(T.getTime() - 3 * DAY),
      );
      await setTrial(boundary, new Date(T.getTime() - 7 * DAY), T);
      await db()
        .update(subscriptions)
        .set({
          status: 'ACTIVE',
          trialEndsAt: null,
          currentTermStart: T,
          currentTermEnd: new Date(T.getTime() + 30 * DAY),
          pricePerMonthBdt: 499,
          chargedBdt: 499,
        })
        .where(eq(subscriptions.billingAccountId, await accountId(later)));
      await db()
        .update(subscriptions)
        .set({ status: 'CANCELED', canceledAt: new Date() })
        .where(eq(subscriptions.billingAccountId, await accountId(canceled)));

      // Before the job: the boundary trial is still TRIALING but no longer live at T.
      expect(
        await service.activePlan(
          boundary.workspaceId,
          new Date(T.getTime() - 1),
        ),
      ).not.toBeNull();
      expect(await service.activePlan(boundary.workspaceId, T)).toBeNull();

      expect(await service.expireDue(T)).toBe(2);
      const statusOf = async (a: Actor) =>
        (await subsOf(await accountId(a))).map((s) => s.status);
      expect(await statusOf(due)).toEqual(['EXPIRED']);
      expect(await statusOf(boundary)).toEqual(['EXPIRED']);
      expect(await statusOf(later)).toEqual(['ACTIVE']);
      expect(await statusOf(canceled)).toEqual(['CANCELED']);
      // Trial end snapshot kept after expiry; second run is a no-op.
      const [expired] = await subsOf(await accountId(boundary));
      expect(expired?.trialEndsAt).toEqual(T);
      expect(await service.expireDue(T)).toBe(0);
      expect(await service.activePlan(later.workspaceId, T)).toMatchObject({
        status: 'ACTIVE',
      });
      expect(await wallet.consume(due.workspaceId, 'monthlyComments')).toBe(
        'no_active_plan',
      );
    });

    it('the billing worker runs subscription-expiry; the scheduler is registered at boot', async () => {
      await app.get(BillingJobSchedulers).ready;
      expect(
        await fakeQueue(app, QUEUE_NAMES.billing).getJobSchedulers(),
      ).toEqual(
        expect.arrayContaining([
          {
            id: 'subscription-expiry-15min',
            repeat: { pattern: '*/15 * * * *', tz: 'Asia/Dhaka' },
            template: {
              name: SUBSCRIPTION_EXPIRY_JOB_NAME,
              data: {},
              opts: { ...DEFAULT_JOB_OPTIONS },
            },
          },
        ]),
      );
      const owner = await actors.signUp('pwt3-job', { trial: true });
      const account = (await accountOf(owner.id))!;
      const past = new Date(Date.now() - 2 * DAY);
      await db()
        .update(subscriptions)
        .set({
          startedAt: new Date(past.getTime() - 7 * DAY),
          currentTermStart: new Date(past.getTime() - 7 * DAY),
          trialEndsAt: past,
          currentTermEnd: past,
        })
        .where(eq(subscriptions.billingAccountId, account.id));
      const result = await app.get(BillingProcessor).process({
        id: 'repeat:subscription-expiry-15min:1',
        name: SUBSCRIPTION_EXPIRY_JOB_NAME,
        data: {},
      } as never);
      expect(result).toEqual({
        kind: 'subscription_expiry',
        switched: expect.any(Number),
        expired: 1,
      });
      expect((await subsOf(account.id)).map((s) => s.status)).toEqual([
        'EXPIRED',
      ]);
    });
  });

  describe('backfill migration 0023 (PW-D15)', () => {
    it('account per oldest owner (else oldest member), links, fresh trial + wallet; idempotent; accounts with a subscription skipped', async () => {
      const owner = await actors.signUp('pwt3-bf-owner');
      const olderMember = await actors.signUp('pwt3-bf-older');
      const host = await actors.signUp('pwt3-bf-host');
      const oldest = await actors.signUp('pwt3-bf-oldest');
      const empty = await actors.signUp('pwt3-bf-empty');
      const had = await actors.signUp('pwt3-bf-had', { trial: true });
      const noTrial = await actors.signUp('pwt3-bf-notrial');
      const backfillSql = readFileSync(BACKFILL_MIGRATION, 'utf8');
      const rollback = new Error('rollback');
      const longAgo = new Date('2026-01-01T00:00:00.000Z');

      /** Undo sign-up billing for these users inside the transaction. */
      async function unbill(tx: Tx, users: Actor[]) {
        const ids = (
          await tx
            .select({ id: billingAccounts.id })
            .from(billingAccounts)
            .where(
              inArray(
                billingAccounts.ownerUserId,
                users.map((u) => u.id),
              ),
            )
        ).map((r) => r.id);
        await deleteBillingChildren(tx, ids);
        await tx
          .update(workspaces)
          .set({ billingAccountId: null })
          .where(inArray(workspaces.billingAccountId, ids));
        await tx
          .delete(billingAccounts)
          .where(inArray(billingAccounts.id, ids));
      }

      /** Row counts of every billing table (one query at a time: one connection in a tx). */
      async function totals(tx: Tx) {
        const rows: number[] = [];
        for (const table of [
          billingAccounts,
          subscriptions,
          wallets,
          walletBalances,
          walletEntries,
        ]) {
          rows.push((await tx.select({ n: count() }).from(table))[0]!.n);
        }
        return rows;
      }

      await expect(
        db().transaction(async (tx) => {
          // 0023 reads the Starter trial columns that 0029 (PR-T7) dropped.
          await addDroppedPlanColumns(tx);
          await unbill(tx, [owner, olderMember, host, oldest, empty]);
          // owner's workspace: an older moderator, but the owner pays.
          await tx.insert(workspaceMembers).values({
            workspaceId: owner.workspaceId,
            userId: olderMember.id,
            role: 'moderator',
            createdAt: longAgo,
          });
          // host's workspace: no owner left (host → admin); the oldest member pays.
          await tx
            .update(workspaceMembers)
            .set({ role: 'admin' })
            .where(
              and(
                eq(workspaceMembers.workspaceId, host.workspaceId),
                eq(workspaceMembers.userId, host.id),
              ),
            );
          await tx.insert(workspaceMembers).values({
            workspaceId: host.workspaceId,
            userId: oldest.id,
            role: 'moderator',
            createdAt: longAgo,
          });
          // empty's workspace: no members at all → stays unlinked.
          await tx
            .delete(workspaceMembers)
            .where(eq(workspaceMembers.workspaceId, empty.workspaceId));
          // had: an expired subscription and an unlinked workspace → relinked, no new trial.
          const hadAccount = (await accountOf(had.id, tx))!;
          await tx
            .update(subscriptions)
            .set({ status: 'EXPIRED' })
            .where(eq(subscriptions.billingAccountId, hadAccount.id));
          await tx
            .update(workspaces)
            .set({ billingAccountId: null })
            .where(eq(workspaces.id, had.workspaceId));

          await tx.execute(sql.raw(backfillSql));

          const { account: ownerAccount, sub } = await expectFreshTrial(
            owner,
            7,
            300,
            tx,
          );
          // UUIDv7 ids, like the app's.
          expect(ownerAccount.id[14]).toBe('7');
          expect(sub.id[14]).toBe('7');
          expect((await walletOf(ownerAccount.id, tx))!.id[14]).toBe('7');
          const [{ now }] = (
            await tx.execute<{ now: Date }>(sql`select now() as now`)
          ).rows as [{ now: Date }];
          expect(
            Math.abs(sub.startedAt.getTime() - new Date(now).getTime()),
          ).toBeLessThan(1);
          // The other payers got their own trial too.
          await expectFreshTrial(olderMember, 7, 300, tx);
          await expectFreshTrial(oldest, 7, 300, tx);
          expect(await linkOf(host.workspaceId, tx)).toBe(
            (await accountOf(oldest.id, tx))!.id,
          );
          // host owns no workspace any more (admin seat only): no account.
          expect(await accountOf(host.id, tx)).toBeUndefined();
          expect(await linkOf(empty.workspaceId, tx)).toBeNull();
          expect(await accountOf(empty.id, tx)).toBeUndefined();
          expect(await linkOf(had.workspaceId, tx)).toBe(hadAccount.id);
          expect(
            (await subsOf(hadAccount.id, tx)).map((s) => s.status),
          ).toEqual(['EXPIRED']);

          // Re-run: nothing changes.
          const once = await totals(tx);
          await tx.execute(sql.raw(backfillSql));
          expect(await totals(tx)).toEqual(once);

          // trial_days null at migration time: account + link, no trial.
          await unbill(tx, [noTrial]);
          await tx.execute(
            sql`update plans set trial_days = null where slug = 'starter'`,
          );
          await tx.execute(sql.raw(backfillSql));
          const noTrialAccount = (await accountOf(noTrial.id, tx))!;
          expect(await linkOf(noTrial.workspaceId, tx)).toBe(noTrialAccount.id);
          expect(await subsOf(noTrialAccount.id, tx)).toEqual([]);
          expect(await walletOf(noTrialAccount.id, tx)).toBeUndefined();
          throw rollback;
        }),
      ).rejects.toBe(rollback);

      // Rolled back: the sign-up rows are back (account + link, no plan).
      const ownerAccount = (await accountOf(owner.id))!;
      expect(await linkOf(owner.workspaceId)).toBe(ownerAccount.id);
      expect(await subsOf(ownerAccount.id)).toEqual([]);
    });
  });
});
