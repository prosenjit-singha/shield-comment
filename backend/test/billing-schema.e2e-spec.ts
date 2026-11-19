import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  billingAccounts,
  comments,
  plans,
  SUBSCRIPTION_INTERVALS,
  SUBSCRIPTION_STATUSES,
  subscriptions,
  users,
  WALLET_ENTRY_KINDS,
  walletBalances,
  walletEntries,
  wallets,
  workspaces,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/** Postgres SQLSTATE of a failed query (Drizzle wraps the `pg` error in `cause`). */
async function pgCode(
  query: PromiseLike<unknown>,
): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    const pgError = (error as { cause?: { code?: string } }).cause ?? error;
    return (pgError as { code?: string }).code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

const DAY = 86_400_000;

/**
 * PW-T1: billing accounts, subscriptions, the wallet (wallets / balances / ledger), the new plan
 * columns, `workspaces.billing_account_id` and `comments.usage_counted_at` (user decisions
 * 2026-11-19 PW-D3/D4/D5/D8/D12). Schema only: no services or routes yet (PW-T2+).
 */
describe('Billing + wallet schema (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let a: Actor;
  let b: Actor;
  let accountA: string;
  let accountB: string;
  let walletA: string;
  let planId: string;

  const tag = `${Date.now()}`;
  const db = () => actors.db;
  const start = new Date('2026-11-19T10:00:00.000Z');
  const in7Days = new Date(start.getTime() + 7 * DAY);
  const in30Days = new Date(start.getTime() + 30 * DAY);

  /** A valid TRIALING row for `accountA` (override fields per case). */
  const trialRow = (
    patch: Partial<typeof subscriptions.$inferInsert> = {},
  ): typeof subscriptions.$inferInsert => ({
    billingAccountId: accountA,
    planId,
    interval: 'month',
    status: 'TRIALING',
    startedAt: start,
    trialEndsAt: in7Days,
    currentTermStart: start,
    currentTermEnd: in7Days,
    ...patch,
  });

  /** A valid ACTIVE row for `accountA`. */
  const activeRow = (
    patch: Partial<typeof subscriptions.$inferInsert> = {},
  ): typeof subscriptions.$inferInsert => ({
    billingAccountId: accountA,
    planId,
    interval: 'month',
    status: 'ACTIVE',
    startedAt: start,
    currentTermStart: start,
    currentTermEnd: in30Days,
    pricePerMonthBdt: 499,
    chargedBdt: 499,
    ...patch,
  });

  const balanceRow = (
    patch: Partial<typeof walletBalances.$inferInsert> = {},
  ): typeof walletBalances.$inferInsert => ({
    walletId: walletA,
    meter: 'monthlyComments',
    periodStart: start,
    periodEnd: in30Days,
    included: 300,
    ...patch,
  });

  const entryRow = (
    patch: Partial<typeof walletEntries.$inferInsert> = {},
  ): typeof walletEntries.$inferInsert => ({
    walletId: walletA,
    meter: 'monthlyComments',
    periodStart: start,
    kind: 'PLAN_GRANT',
    amount: 300,
    ...patch,
  });

  const deleteSubscriptions = () =>
    db()
      .delete(subscriptions)
      .where(inArray(subscriptions.billingAccountId, [accountA, accountB]));

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    a = await actors.signUp('pwt1-a');
    b = await actors.signUp('pwt1-b');
    // Sign-up now starts a Starter trial (PW-T3): this spec builds its own billing rows.
    await actors.removeBilling(a, b);
    const [plan] = await db()
      .insert(plans)
      .values({
        slug: `pwt1-${tag}`,
        name: `PWT1 ${tag}`,
        sortOrder: 90,
        monthlyPriceBdt: 999,
        featureConfig: {
          limits: {
            connectedPages: 1,
            monthlyComments: 100,
            teamSeats: 1,
            workspaces: 1,
          },
          features: {
            banglaAiFilter: true,
            autoHideScams: true,
            customBlocklist: false,
            autoReplyTemplates: false,
            messengerAlerts: false,
            whiteLabelReports: false,
            prioritySupportApi: false,
          },
        },
      })
      .returning({ id: plans.id });
    planId = plan!.id;
    const [rowA] = await db()
      .insert(billingAccounts)
      .values({ ownerUserId: a.id })
      .returning({ id: billingAccounts.id });
    const [rowB] = await db()
      .insert(billingAccounts)
      .values({ ownerUserId: b.id })
      .returning({ id: billingAccounts.id });
    accountA = rowA!.id;
    accountB = rowB!.id;
    const [wallet] = await db()
      .insert(wallets)
      .values({
        billingAccountId: accountA,
        cycleAnchorAt: start,
        currentPeriodStart: start,
        currentPeriodEnd: in7Days,
      })
      .returning({ id: wallets.id });
    walletA = wallet!.id;
  });

  afterAll(async () => {
    if (actors) {
      await actors.cleanup();
      if (planId) await db().delete(plans).where(eq(plans.id, planId));
    }
    await app?.close();
  });

  it('migration 0021 is applied (journal count = applied rows)', async () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain(
      '0021_billing_wallet_schema',
    );
    const result = await db().execute<{ applied: number }>(
      sql`select count(*)::int as applied from drizzle.__drizzle_migrations`,
    );
    expect(result.rows[0]?.applied).toBe(journal.entries.length);
  });

  describe('billing_accounts', () => {
    it('one account per owner user', async () => {
      expect(
        await pgCode(
          db().insert(billingAccounts).values({ ownerUserId: a.id }),
        ),
      ).toBe(UNIQUE_VIOLATION);
    });

    it('rejects an unknown owner (FK)', async () => {
      expect(
        await pgCode(
          db()
            .insert(billingAccounts)
            .values({ ownerUserId: '00000000-0000-7000-8000-000000000000' }),
        ),
      ).toBe(FK_VIOLATION);
    });

    it('workspaces.billing_account_id: nullable, set to an account, FK restrict', async () => {
      const [before] = await db()
        .select({ billingAccountId: workspaces.billingAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, a.workspaceId));
      expect(before?.billingAccountId).toBeNull();
      await db()
        .update(workspaces)
        .set({ billingAccountId: accountA })
        .where(eq(workspaces.id, a.workspaceId));
      expect(
        await pgCode(
          db().delete(billingAccounts).where(eq(billingAccounts.id, accountA)),
        ),
      ).toBe(FK_VIOLATION);
      expect(
        await pgCode(
          db()
            .update(workspaces)
            .set({ billingAccountId: '00000000-0000-7000-8000-000000000000' })
            .where(eq(workspaces.id, a.workspaceId)),
        ),
      ).toBe(FK_VIOLATION);
    });

    it('deleting a user who owns an account is restricted', async () => {
      expect(await pgCode(db().delete(users).where(eq(users.id, b.id)))).toBe(
        FK_VIOLATION,
      );
    });
  });

  describe('subscriptions', () => {
    afterEach(deleteSubscriptions);

    it('accepts a trial, an active term on each interval, expired and canceled rows', async () => {
      await db().insert(subscriptions).values(trialRow());
      await deleteSubscriptions();
      for (const interval of SUBSCRIPTION_INTERVALS) {
        await db()
          .insert(subscriptions)
          .values(
            activeRow({
              interval,
              chargedBdt: interval === 'year' ? 449 * 12 : 499,
              pricePerMonthBdt: interval === 'year' ? 449 : 499,
            }),
          );
        await deleteSubscriptions();
      }
      // History: an expired trial keeps its trial end; a canceled paid term keeps its prices.
      await db()
        .insert(subscriptions)
        .values([
          trialRow({ status: 'EXPIRED' }),
          activeRow({ status: 'CANCELED', canceledAt: in7Days }),
          activeRow({ status: 'EXPIRED' }),
        ]);
      const rows = await db()
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.billingAccountId, accountA));
      expect(rows.map((r) => r.status).sort()).toEqual([
        'CANCELED',
        'EXPIRED',
        'EXPIRED',
      ]);
      expect([...SUBSCRIPTION_STATUSES].sort()).toEqual([
        'ACTIVE',
        'CANCELED',
        'EXPIRED',
        'TRIALING',
      ]);
    });

    it.each([
      ['unknown interval', trialRowPatch({ interval: 'week' })],
      ['unknown status', trialRowPatch({ status: 'PAUSED' })],
      ['term end = start', trialRowPatch({ currentTermEnd: 'start' })],
      ['trial end before start', trialRowPatch({ trialEndsAt: 'before' })],
      ['trial without trial end', trialRowPatch({ trialEndsAt: null })],
      ['trial end ≠ term end', trialRowPatch({ currentTermEnd: '30d' })],
      [
        'trial with prices',
        trialRowPatch({ pricePerMonthBdt: 0, chargedBdt: 0 }),
      ],
      [
        'active without prices',
        activeRowPatch({ pricePerMonthBdt: null, chargedBdt: null }),
      ],
      ['price without charged', activeRowPatch({ chargedBdt: null })],
      ['charged without price', activeRowPatch({ pricePerMonthBdt: null })],
      ['negative price', activeRowPatch({ pricePerMonthBdt: -1 })],
      ['negative charged', activeRowPatch({ chargedBdt: -1 })],
      ['canceled without canceled_at', activeRowPatch({ status: 'CANCELED' })],
      ['canceled_at on an active row', activeRowPatch({ canceledAt: 'start' })],
    ])('rejects %s (23514)', async (_label, make) => {
      expect(
        await pgCode(
          db()
            .insert(subscriptions)
            .values(make() as never),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('one live (TRIALING/ACTIVE) subscription per account; history rows do not count', async () => {
      await db().insert(subscriptions).values(trialRow());
      expect(await pgCode(db().insert(subscriptions).values(activeRow()))).toBe(
        UNIQUE_VIOLATION,
      );
      expect(await pgCode(db().insert(subscriptions).values(trialRow()))).toBe(
        UNIQUE_VIOLATION,
      );
      // Trial expires → a paid ACTIVE term is allowed beside the EXPIRED row.
      await db()
        .update(subscriptions)
        .set({ status: 'EXPIRED' })
        .where(eq(subscriptions.billingAccountId, accountA));
      await db().insert(subscriptions).values(activeRow());
      // Another account is independent.
      await db()
        .insert(subscriptions)
        .values(activeRow({ billingAccountId: accountB }));
      expect(await pgCode(db().insert(subscriptions).values(activeRow()))).toBe(
        UNIQUE_VIOLATION,
      );
    });

    it('FK restrict: account and plan cannot be deleted while a subscription points at them', async () => {
      await db().insert(subscriptions).values(activeRow());
      expect(await pgCode(db().delete(plans).where(eq(plans.id, planId)))).toBe(
        FK_VIOLATION,
      );
      expect(
        await pgCode(
          db().delete(billingAccounts).where(eq(billingAccounts.id, accountB)),
        ),
      ).toBeUndefined();
      // Recreate B's account (cleanup and later tests expect it).
      const [row] = await db()
        .insert(billingAccounts)
        .values({ ownerUserId: b.id })
        .returning({ id: billingAccounts.id });
      accountB = row!.id;
      expect(
        await pgCode(
          db().delete(billingAccounts).where(eq(billingAccounts.id, accountA)),
        ),
      ).toBe(FK_VIOLATION);
    });

    /** Builders resolved at run time (the account/plan ids exist only after beforeAll). */
    function trialRowPatch(patch: Record<string, unknown>) {
      return () => trialRow(resolve(patch));
    }
    function activeRowPatch(patch: Record<string, unknown>) {
      return () => activeRow(resolve(patch));
    }
    function resolve(patch: Record<string, unknown>) {
      const times: Record<string, Date> = {
        start,
        before: new Date(start.getTime() - DAY),
        '30d': in30Days,
      };
      return Object.fromEntries(
        Object.entries(patch).map(([k, v]) => [
          k,
          typeof v === 'string' && v in times ? times[v] : v,
        ]),
      ) as Partial<typeof subscriptions.$inferInsert>;
    }
  });

  describe('wallets', () => {
    it('one wallet per account', async () => {
      expect(
        await pgCode(
          db().insert(wallets).values({
            billingAccountId: accountA,
            cycleAnchorAt: start,
            currentPeriodStart: start,
            currentPeriodEnd: in30Days,
          }),
        ),
      ).toBe(UNIQUE_VIOLATION);
    });

    it('rejects a period that ends at its start (23514)', async () => {
      expect(
        await pgCode(
          db().insert(wallets).values({
            billingAccountId: accountB,
            cycleAnchorAt: start,
            currentPeriodStart: start,
            currentPeriodEnd: start,
          }),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('the account cannot be deleted while it has a wallet', async () => {
      await db()
        .update(workspaces)
        .set({ billingAccountId: null })
        .where(eq(workspaces.id, a.workspaceId));
      expect(
        await pgCode(
          db().delete(billingAccounts).where(eq(billingAccounts.id, accountA)),
        ),
      ).toBe(FK_VIOLATION);
    });
  });

  describe('wallet_balances', () => {
    afterEach(() =>
      db().delete(walletBalances).where(eq(walletBalances.walletId, walletA)),
    );

    it('stores a balance with added/used defaulting to 0; unique per wallet × meter × period', async () => {
      const [row] = await db()
        .insert(walletBalances)
        .values(balanceRow())
        .returning();
      expect(row).toMatchObject({ included: 300, added: 0, used: 0 });
      expect(
        await pgCode(db().insert(walletBalances).values(balanceRow())),
      ).toBe(UNIQUE_VIOLATION);
      // Another meter or another period is a new row.
      await db()
        .insert(walletBalances)
        .values([
          balanceRow({ meter: 'autoReplies' }),
          balanceRow({
            periodStart: in30Days,
            periodEnd: new Date(in30Days.getTime() + 30 * DAY),
          }),
        ]);
    });

    it.each([
      ['snake_case meter', { meter: 'monthly_comments' }],
      ['capitalised meter', { meter: 'MonthlyComments' }],
      ['empty meter', { meter: '' }],
      ['meter > 64 chars', { meter: `m${'x'.repeat(64)}` }],
      ['negative included', { included: -1 }],
      ['negative added', { added: -1 }],
      ['negative used', { used: -1 }],
      ['period end = start', { periodEnd: start }],
    ])('rejects %s (23514)', async (_label, patch) => {
      expect(
        await pgCode(
          db()
            .insert(walletBalances)
            .values(balanceRow(patch as never)),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('the wallet cannot be deleted while it has balances (FK restrict)', async () => {
      await db().insert(walletBalances).values(balanceRow());
      expect(
        await pgCode(db().delete(wallets).where(eq(wallets.id, walletA))),
      ).toBe(FK_VIOLATION);
    });
  });

  describe('wallet_entries', () => {
    afterEach(() =>
      db().delete(walletEntries).where(eq(walletEntries.walletId, walletA)),
    );

    it('accepts every kind with a valid amount; no updated_at column', async () => {
      const amounts: Record<(typeof WALLET_ENTRY_KINDS)[number], number> = {
        PLAN_GRANT: 0,
        ADJUSTMENT: -5,
        TOP_UP: 100,
        EXPIRE: -100,
      };
      for (const kind of WALLET_ENTRY_KINDS) {
        await db()
          .insert(walletEntries)
          .values(entryRow({ kind, amount: amounts[kind] }));
      }
      const [row] = await db()
        .insert(walletEntries)
        .values(
          entryRow({
            reference: 'subscription:123',
            note: 'n'.repeat(500),
            actorUserId: b.id,
          }),
        )
        .returning();
      expect(row).toMatchObject({ createdAt: expect.any(Date) });
      expect(row).not.toHaveProperty('updatedAt');
    });

    it.each([
      ['unknown kind', { kind: 'REFUND' }],
      ['bad meter', { meter: 'monthly-comments' }],
      ['negative grant', { kind: 'PLAN_GRANT', amount: -1 }],
      ['zero top-up', { kind: 'TOP_UP', amount: 0 }],
      ['positive expiry', { kind: 'EXPIRE', amount: 1 }],
      ['zero adjustment', { kind: 'ADJUSTMENT', amount: 0 }],
      ['empty reference', { reference: '' }],
      ['reference > 200', { reference: 'r'.repeat(201) }],
      ['empty note', { note: '' }],
      ['note > 500', { note: 'n'.repeat(501) }],
    ])('rejects %s (23514)', async (_label, patch) => {
      expect(
        await pgCode(
          db()
            .insert(walletEntries)
            .values(entryRow(patch as never)),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('the actor is set null when the user is deleted; the wallet is restricted', async () => {
      const extra = await actors.signUp('pwt1-actor');
      await actors.removeBilling(extra);
      const [entry] = await db()
        .insert(walletEntries)
        .values(
          entryRow({ kind: 'ADJUSTMENT', amount: 10, actorUserId: extra.id }),
        )
        .returning({ id: walletEntries.id });
      // The extra user has no billing account: deleting it only nulls the ledger actor.
      await db().delete(workspaces).where(eq(workspaces.id, extra.workspaceId));
      await db().delete(users).where(eq(users.id, extra.id));
      const [row] = await db()
        .select({ actorUserId: walletEntries.actorUserId })
        .from(walletEntries)
        .where(eq(walletEntries.id, entry!.id));
      expect(row?.actorUserId).toBeNull();
      expect(
        await pgCode(db().delete(wallets).where(eq(wallets.id, walletA))),
      ).toBe(FK_VIOLATION);
    });
  });

  describe('plans: yearly price', () => {
    const setPlan = (patch: Partial<typeof plans.$inferInsert>) =>
      db().update(plans).set(patch).where(eq(plans.id, planId));

    afterAll(() =>
      setPlan({ monthlyPriceBdt: 999, yearlyMonthlyPriceBdt: null }),
    );

    it('the seeded plans carry the PW-T1b yearly prices (migration 0022; yearly = list price since 0027)', async () => {
      const rows = await db()
        .select({ slug: plans.slug, yearly: plans.yearlyMonthlyPriceBdt })
        .from(plans)
        .where(inArray(plans.slug, ['free', 'starter', 'growth', 'pro']))
        .orderBy(plans.sortOrder);
      expect(rows).toEqual([
        { slug: 'free', yearly: null },
        { slug: 'starter', yearly: 949 },
        { slug: 'growth', yearly: 2349 },
        { slug: 'pro', yearly: 5599 },
      ]);
    });

    it('accepts the edge values (the yearly price is capped by the monthly list price, PR-T1)', async () => {
      await setPlan({ yearlyMonthlyPriceBdt: 0 });
      await setPlan({ yearlyMonthlyPriceBdt: 999 });
    });

    it.each([
      ['yearly per-month > list price', { yearlyMonthlyPriceBdt: 1000 }],
      ['negative yearly price', { yearlyMonthlyPriceBdt: -1 }],
      [
        'list price lowered below the yearly price',
        { yearlyMonthlyPriceBdt: 949, monthlyPriceBdt: 900 },
      ],
    ])('rejects %s (23514)', async (_label, patch) => {
      expect(await pgCode(setPlan(patch))).toBe(CHECK_VIOLATION);
    });
  });

  it('comments.usage_counted_at is a nullable timestamp', async () => {
    const [row] = await db()
      .insert(comments)
      .values({
        commentId: `9${tag}1_9${tag}2`,
        workspaceId: a.workspaceId,
        platform: 'FACEBOOK',
        postId: `9${tag}1_1`,
      })
      .returning({ id: comments.id, usageCountedAt: comments.usageCountedAt });
    expect(row?.usageCountedAt).toBeNull();
    const [updated] = await db()
      .update(comments)
      .set({ usageCountedAt: start })
      .where(eq(comments.id, row!.id))
      .returning({ usageCountedAt: comments.usageCountedAt });
    expect(updated?.usageCountedAt).toEqual(start);
  });

  it('cleanup() deletes the wallet, ledger, subscriptions and accounts before the users', async () => {
    await db()
      .update(workspaces)
      .set({ billingAccountId: accountA })
      .where(eq(workspaces.id, a.workspaceId));
    await db().insert(subscriptions).values(trialRow());
    await db().insert(walletBalances).values(balanceRow());
    await db()
      .insert(walletEntries)
      .values(entryRow({ actorUserId: a.id }));
    await actors.cleanup();
    const accounts = [accountA, accountB];
    expect(
      await db()
        .select()
        .from(billingAccounts)
        .where(inArray(billingAccounts.id, accounts)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(subscriptions)
        .where(inArray(subscriptions.billingAccountId, accounts)),
    ).toEqual([]);
    expect(
      await db().select().from(wallets).where(eq(wallets.id, walletA)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(walletBalances)
        .where(eq(walletBalances.walletId, walletA)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(walletEntries)
        .where(eq(walletEntries.walletId, walletA)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(users)
        .where(inArray(users.id, [a.id, b.id])),
    ).toEqual([]);
  });
});
