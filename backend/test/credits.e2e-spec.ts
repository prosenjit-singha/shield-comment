import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { CreditService } from '../src/credits/credit.service.js';
import type { Database } from '../src/db/database.js';
import {
  monthlyCreditUsage,
  plans,
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

const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

/** Mid-November 2026 in Dhaka; the month ends at 2026-11-30T18:00:00Z. */
const NOV = new Date('2026-11-15T06:00:00.000Z');
const NOV_LAST = new Date('2026-11-30T17:59:59.999Z');
const DEC_FIRST = new Date('2026-11-30T18:00:00.000Z');

const limits = (monthlyAiCredits: number) => ({
  limits: { connectedPages: 1, monthlyAiCredits, teamSeats: 1 },
  features: {},
});

/**
 * M5-T11: `monthly_credit_usage` (migration 0019) + `CreditService` against real Postgres (user
 * decisions 2026-11-19 D15 credits = the only plan limit, Dhaka month, no rollover, no plan = Free;
 * D7 atomic reserve, never below 0). Throwaway plans (`m5t11-*`) are removed in `afterAll`
 * after `cleanup()` has deleted the workspaces that use them.
 */
describe('Monthly AI credits (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let credits: CreditService;
  let a: Actor;
  let b: Actor;
  const planIds: Record<string, string> = {};
  const tag = Date.now().toString(36);

  const db = (): Database => actors.db;
  const setPlan = (workspaceId: string, planId: string | null) =>
    db()
      .update(workspaces)
      .set({ planId })
      .where(eq(workspaces.id, workspaceId));
  const usageRows = (workspaceId: string) =>
    db()
      .select({
        month: monthlyCreditUsage.month,
        used: monthlyCreditUsage.used,
      })
      .from(monthlyCreditUsage)
      .where(eq(monthlyCreditUsage.workspaceId, workspaceId))
      .orderBy(monthlyCreditUsage.month);

  async function insertPlan(key: string, featureConfig: unknown) {
    const [row] = await db()
      .insert(plans)
      .values({
        slug: `m5t11-${key}-${tag}`,
        name: `M5T11 ${key} ${tag}`,
        sortOrder: 90,
        originalPriceBdt: 0,
        featureConfig: featureConfig as typeof plans.$inferInsert.featureConfig,
      })
      .returning({ id: plans.id });
    planIds[key] = row!.id;
    return row!.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    credits = app.get(CreditService);
    a = await actors.signUp('m5t11-a');
    b = await actors.signUp('m5t11-b');
    await insertPlan('five', limits(5));
    await insertPlan('ten', limits(10));
    await insertPlan('legacy', {
      limits: { connectedPages: 1, monthlyComments: 7, teamSeats: 1 },
    });
    await insertPlan('nokey', { limits: { connectedPages: 1 } });
  });

  afterAll(async () => {
    if (actors) {
      await actors.cleanup();
      const ids = Object.values(planIds);
      if (ids.length) await db().delete(plans).where(inArray(plans.id, ids));
    }
    await app?.close();
  });

  beforeEach(async () => {
    await db()
      .delete(monthlyCreditUsage)
      .where(
        inArray(monthlyCreditUsage.workspaceId, [a.workspaceId, b.workspaceId]),
      );
    await setPlan(a.workspaceId, planIds.five!);
    await setPlan(b.workspaceId, planIds.five!);
  });

  it('migration 0019 is applied (journal count = applied rows)', async () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toEqual(
      expect.arrayContaining([
        '0018_plan_ai_credits',
        '0019_monthly_credit_usage',
      ]),
    );
    const result = await db().execute<{ applied: number }>(
      sql`select count(*)::int as applied from drizzle.__drizzle_migrations`,
    );
    expect(result.rows[0]?.applied).toBe(journal.entries.length);
  });

  it('20 parallel reserves of 1 with a limit of 5 → exactly 5 succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => credits.reserve(a.workspaceId, 1, NOV)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await usageRows(a.workspaceId)).toEqual([
      { month: '2026-11', used: 5 },
    ]);
    await expect(credits.usage(a.workspaceId, NOV)).resolves.toEqual({
      used: 5,
      limit: 5,
      period: '2026-11',
    });
  });

  it('a cost that would pass the limit is refused and changes nothing', async () => {
    expect(await credits.reserve(a.workspaceId, 2, NOV)).toBe(true);
    expect(await credits.reserve(a.workspaceId, 2, NOV)).toBe(true);
    expect(await credits.reserve(a.workspaceId, 2, NOV)).toBe(false);
    expect(await credits.reserve(a.workspaceId, 1, NOV)).toBe(true);
    expect(await credits.reserve(a.workspaceId, 1, NOV)).toBe(false);
    expect((await credits.usage(a.workspaceId, NOV)).used).toBe(5);
    // A cost above the limit on an empty month writes no row.
    await setPlan(b.workspaceId, planIds.five!);
    expect(await credits.reserve(b.workspaceId, 6, NOV)).toBe(false);
    expect(await usageRows(b.workspaceId)).toEqual([]);
  });

  it('release gives credits back, never below 0, only in its month', async () => {
    expect(await credits.release(a.workspaceId, 1, NOV)).toBe(false);
    await credits.reserve(a.workspaceId, 2, NOV);
    await credits.reserve(a.workspaceId, 2, NOV);
    expect(await credits.release(a.workspaceId, 2, NOV)).toBe(true);
    expect((await credits.usage(a.workspaceId, NOV)).used).toBe(2);
    // Another month has no row: nothing to give back there.
    expect(await credits.release(a.workspaceId, 1, DEC_FIRST)).toBe(false);
    expect(await credits.release(a.workspaceId, 5, NOV)).toBe(true);
    expect((await credits.usage(a.workspaceId, NOV)).used).toBe(0);
    // The freed credits can be reserved again.
    const again = await Promise.all(
      Array.from({ length: 8 }, () => credits.reserve(a.workspaceId, 1, NOV)),
    );
    expect(again.filter(Boolean)).toHaveLength(5);
  });

  it('a plan change applies at once (higher, and lower than already used)', async () => {
    for (let i = 0; i < 5; i++) await credits.reserve(a.workspaceId, 1, NOV);
    expect(await credits.reserve(a.workspaceId, 1, NOV)).toBe(false);
    await setPlan(a.workspaceId, planIds.ten!);
    expect(await credits.reserve(a.workspaceId, 2, NOV)).toBe(true);
    await expect(credits.usage(a.workspaceId, NOV)).resolves.toEqual({
      used: 7,
      limit: 10,
      period: '2026-11',
    });
    // Back to 5 while 7 are used: nothing more passes, usage shows used > limit.
    await setPlan(a.workspaceId, planIds.five!);
    expect(await credits.reserve(a.workspaceId, 1, NOV)).toBe(false);
    await expect(credits.usage(a.workspaceId, NOV)).resolves.toEqual({
      used: 7,
      limit: 5,
      period: '2026-11',
    });
  });

  it('no plan = the Free plan limit; old key read as fallback; missing key or workspace = 0', async () => {
    const [free] = await db()
      .select({ featureConfig: plans.featureConfig })
      .from(plans)
      .where(eq(plans.slug, 'free'));
    const freeLimit = free!.featureConfig.limits.monthlyAiCredits;
    expect(freeLimit).toBe(500);
    await setPlan(a.workspaceId, null);
    await expect(credits.usage(a.workspaceId, NOV)).resolves.toEqual({
      used: 0,
      limit: freeLimit,
      period: '2026-11',
    });
    expect(await credits.reserve(a.workspaceId, 2, NOV)).toBe(true);

    await setPlan(a.workspaceId, planIds.legacy!);
    expect((await credits.usage(a.workspaceId, NOV)).limit).toBe(7);

    await setPlan(b.workspaceId, planIds.nokey!);
    expect((await credits.usage(b.workspaceId, NOV)).limit).toBe(0);
    expect(await credits.reserve(b.workspaceId, 1, NOV)).toBe(false);

    const unknown = '01a1ecf3-0000-7000-8000-000000000000';
    await expect(credits.usage(unknown, NOV)).resolves.toEqual({
      used: 0,
      limit: 0,
      period: '2026-11',
    });
    expect(await credits.reserve(unknown, 1, NOV)).toBe(false);
  });

  it('a new Dhaka month starts at 0 (no rollover); boundary at 18:00Z on the last day', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await credits.reserve(a.workspaceId, 1, NOV_LAST)).toBe(true);
    }
    expect(await credits.reserve(a.workspaceId, 1, NOV_LAST)).toBe(false);
    expect(await credits.reserve(a.workspaceId, 1, DEC_FIRST)).toBe(true);
    expect(await usageRows(a.workspaceId)).toEqual([
      { month: '2026-11', used: 5 },
      { month: '2026-12', used: 1 },
    ]);
    await expect(credits.usage(a.workspaceId, DEC_FIRST)).resolves.toEqual({
      used: 1,
      limit: 5,
      period: '2026-12',
    });
  });

  it('workspaces are isolated', async () => {
    for (let i = 0; i < 5; i++) await credits.reserve(a.workspaceId, 1, NOV);
    expect(await credits.reserve(a.workspaceId, 1, NOV)).toBe(false);
    expect(await credits.reserve(b.workspaceId, 1, NOV)).toBe(true);
    await credits.release(b.workspaceId, 1, NOV);
    expect((await credits.usage(a.workspaceId, NOV)).used).toBe(5);
    expect((await credits.usage(b.workspaceId, NOV)).used).toBe(0);
  });

  it('constraints: month format, used ≥ 0, one row per workspace + month, workspace FK restrict', async () => {
    const insert = (month: string, used = 0, workspaceId = b.workspaceId) =>
      db().insert(monthlyCreditUsage).values({ workspaceId, month, used });
    for (const month of ['2026-13', '2026-1', '2026-11-01', 'x']) {
      expect(await pgCode(insert(month))).toBe(CHECK_VIOLATION);
    }
    expect(await pgCode(insert('2026-10', -1))).toBe(CHECK_VIOLATION);
    await insert('2026-10', 3);
    expect(await pgCode(insert('2026-10', 1))).toBe(UNIQUE_VIOLATION);
    expect(
      await pgCode(
        db().delete(workspaces).where(eq(workspaces.id, b.workspaceId)),
      ),
    ).toBe(FK_VIOLATION);
    const [row] = await db()
      .select()
      .from(monthlyCreditUsage)
      .where(
        and(
          eq(monthlyCreditUsage.workspaceId, b.workspaceId),
          eq(monthlyCreditUsage.month, '2026-10'),
        ),
      );
    expect(row?.used).toBe(3);
  });
});
