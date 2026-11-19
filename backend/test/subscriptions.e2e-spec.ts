import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { BillingJobSchedulers } from '../src/billing/billing-job-schedulers.js';
import { SUBSCRIPTION_EXPIRY_JOB_NAME } from '../src/billing/billing-scheduled.jobs.js';
import { BillingProcessor } from '../src/billing/billing.processor.js';
import { SubscriptionService } from '../src/billing/subscription.service.js';
import type { Database } from '../src/db/database.js';
import {
  billingAccounts,
  plans,
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
import { fakeQueue } from './utils/fake-queue.js';

const DAY = 86_400_000;
const BACKFILL_MIGRATION = new URL(
  '../drizzle/0023_billing_account_trial_backfill.sql',
  import.meta.url,
);

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

/**
 * PW-T3: Starter trial at sign-up + subscription expiry (user decisions 2026-11-19 PW-D8 trial once
 * per account, admin-adjustable length for new trials only; PW-D9 expiry; PW-D12 trial comment
 * limit 300; PW-D15 backfill). Real Postgres; the Starter plan's trial values are restored after
 * the tests that change them (7 days / 300 comments, seeded by 0022).
 */
describe('Subscriptions + Starter trial (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let service: SubscriptionService;
  let wallet: WalletService;
  let starterId: string;

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

  const setStarterTrial = (
    trialDays: number | null,
    trialCommentLimit: number | null,
    ex: Executor = db(),
  ) =>
    ex
      .update(plans)
      .set({ trialDays, trialCommentLimit })
      .where(eq(plans.id, starterId));

  /** Everything a new trial writes, checked against the given trial values. */
  async function expectFreshTrial(
    actor: Actor,
    days: number,
    grant: number,
    ex: Executor = db(),
  ) {
    const account = await accountOf(actor.id, ex);
    expect(account, 'billing account').toBeDefined();
    expect(await linkOf(actor.workspaceId, ex)).toBe(account!.id);
    const subs = await subsOf(account!.id, ex);
    expect(subs).toHaveLength(1);
    const sub = subs[0]!;
    expect(sub).toMatchObject({
      planId: starterId,
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
    const [starter] = await db()
      .select({
        id: plans.id,
        trialDays: plans.trialDays,
        trialCommentLimit: plans.trialCommentLimit,
      })
      .from(plans)
      .where(eq(plans.slug, 'starter'));
    starterId = starter!.id;
    // The seed (0022) this spec is written against.
    expect(starter).toMatchObject({ trialDays: 7, trialCommentLimit: 300 });
  });

  afterAll(async () => {
    if (actors) {
      await setStarterTrial(7, 300);
      await actors.cleanup();
    }
    await app?.close();
  });

  describe('sign-up', () => {
    it('creates the account, links the workspace and starts a 7-day trial with a 300-comment wallet', async () => {
      const before = Date.now();
      const owner = await actors.signUp('pwt3-signup');
      const { account, sub } = await expectFreshTrial(owner, 7, 300);
      expect(account.ownerUserId).toBe(owner.id);
      expect(sub.startedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(sub.startedAt.getTime()).toBeLessThanOrEqual(Date.now());

      const live = await service.activePlan(owner.workspaceId);
      expect(live).toMatchObject({
        workspaceId: owner.workspaceId,
        billingAccountId: account.id,
        subscriptionId: sub.id,
        status: 'TRIALING',
        plan: { id: starterId, slug: 'starter', trialCommentLimit: 300 },
      });
      expect(await wallet.balance(owner.workspaceId)).toMatchObject({
        included: 300,
        used: 0,
        available: 300,
        resetsAt: sub.currentTermEnd,
      });
      expect(await wallet.consume(owner.workspaceId, 'monthlyComments')).toBe(
        'ok',
      );
    });

    it('a changed trial_days / trial_comment_limit applies to new trials only', async () => {
      const early = await actors.signUp('pwt3-early');
      try {
        await setStarterTrial(14, 50);
        const late = await actors.signUp('pwt3-late');
        await expectFreshTrial(early, 7, 300);
        await expectFreshTrial(late, 14, 50);
        expect(await wallet.balance(early.workspaceId)).toMatchObject({
          included: 300,
        });
        expect(await wallet.balance(late.workspaceId)).toMatchObject({
          included: 50,
        });
        // trial_comment_limit null = the plan's monthly comment limit.
        await setStarterTrial(3, null);
        const fallback = await actors.signUp('pwt3-fallback');
        const [plan] = await db()
          .select({ featureConfig: plans.featureConfig })
          .from(plans)
          .where(eq(plans.id, starterId));
        await expectFreshTrial(
          fallback,
          3,
          plan!.featureConfig.limits.monthlyComments,
        );
      } finally {
        await setStarterTrial(7, 300);
      }
    });

    it('trial_days null = no trial: account + link only, the trial comes on a later session create', async () => {
      let owner!: Actor;
      try {
        await setStarterTrial(null, 300);
        owner = await actors.signUp('pwt3-notrial');
        const account = await accountOf(owner.id);
        expect(await linkOf(owner.workspaceId)).toBe(account!.id);
        expect(await subsOf(account!.id)).toEqual([]);
        expect(await walletOf(account!.id)).toBeUndefined();
        expect(await service.activePlan(owner.workspaceId)).toBeNull();
      } finally {
        await setStarterTrial(7, 300);
      }
      await actors.signIn(owner.email);
      await expectFreshTrial(owner, 7, 300);
    });
  });

  describe('trial once per account', () => {
    it('startTrial returns null while a trial runs and after it expired', async () => {
      const owner = await actors.signUp('pwt3-once');
      const account = (await accountOf(owner.id))!;
      expect(await service.startTrial(account.id)).toBeNull();
      await db()
        .update(subscriptions)
        .set({ status: 'EXPIRED' })
        .where(eq(subscriptions.billingAccountId, account.id));
      expect(await service.startTrial(account.id)).toBeNull();
      // A new session doesn't start one either (the account had a subscription).
      await actors.signIn(owner.email);
      const subs = await subsOf(account.id);
      expect(subs.map((s) => s.status)).toEqual(['EXPIRED']);
      expect(await service.activePlan(owner.workspaceId)).toBeNull();
    });

    it('concurrent startTrial / ensureAccount calls create one account and one trial', async () => {
      const owner = await actors.signUp('pwt3-race');
      await actors.removeBilling(owner);
      const ids = await Promise.all(
        [1, 2, 3].map(() => service.ensureAccount(owner.id)),
      );
      expect(new Set(ids).size).toBe(1);
      const results = await Promise.all(
        [1, 2, 3].map(() => service.startTrial(ids[0]!)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await subsOf(ids[0]!)).toHaveLength(1);
      expect(await balancesOf(ids[0]!)).toHaveLength(1);
      expect(await entriesOf(ids[0]!)).toHaveLength(1);
    });
  });

  describe('repair on the next session create', () => {
    it('an owner whose workspace has no account gets account + link + trial at sign-in', async () => {
      const owner = await actors.signUp('pwt3-repair');
      await actors.removeBilling(owner);
      expect(await accountOf(owner.id)).toBeUndefined();
      expect(await linkOf(owner.workspaceId)).toBeNull();
      await actors.signIn(owner.email);
      const { sub } = await expectFreshTrial(owner, 7, 300);
      // Already set up: another sign-in changes nothing.
      await actors.signIn(owner.email);
      expect((await subsOf(sub.billingAccountId)).map((s) => s.id)).toEqual([
        sub.id,
      ]);
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
      const owner = await actors.signUp('pwt3-second');
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
      const due = await actors.signUp('pwt3-due');
      const boundary = await actors.signUp('pwt3-boundary');
      const later = await actors.signUp('pwt3-later');
      const canceled = await actors.signUp('pwt3-canceled');
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
      ).toEqual([
        {
          id: 'subscription-expiry-15min',
          repeat: { pattern: '*/15 * * * *', tz: 'Asia/Dhaka' },
          template: {
            name: SUBSCRIPTION_EXPIRY_JOB_NAME,
            data: {},
            opts: { ...DEFAULT_JOB_OPTIONS },
          },
        },
      ]);
      const owner = await actors.signUp('pwt3-job');
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
      expect(result).toEqual({ kind: 'subscription_expiry', expired: 1 });
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
      const had = await actors.signUp('pwt3-bf-had');
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
          await setStarterTrial(null, 300, tx);
          await tx.execute(sql.raw(backfillSql));
          const noTrialAccount = (await accountOf(noTrial.id, tx))!;
          expect(await linkOf(noTrial.workspaceId, tx)).toBe(noTrialAccount.id);
          expect(await subsOf(noTrialAccount.id, tx)).toEqual([]);
          expect(await walletOf(noTrialAccount.id, tx)).toBeUndefined();
          throw rollback;
        }),
      ).rejects.toBe(rollback);

      // Rolled back: the sign-up rows are back, the Starter trial values too.
      await expectFreshTrial(owner, 7, 300);
      const [starter] = await db()
        .select({ trialDays: plans.trialDays })
        .from(plans)
        .where(eq(plans.id, starterId));
      expect(starter?.trialDays).toBe(7);
    });
  });
});
