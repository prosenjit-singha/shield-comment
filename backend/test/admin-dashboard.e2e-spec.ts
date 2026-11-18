import type { INestApplication } from '@nestjs/common';
import { asc, count, eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { dhakaBucketKey } from '../src/admin/dashboard-range.js';
import type { DashboardStatsResponse } from '../src/admin/dto/dashboard-stats.dto.js';
import {
  plans,
  tickets,
  UNRESOLVED_TICKET_STATUSES,
  workspaces,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const STATS = '/api/admin/dashboard/stats';

/**
 * M2-T5: `GET /api/admin/dashboard/stats`. Ranges/buckets in Asia/Dhaka (UTC+6); client growth is
 * real, every other source is zero-filled until it exists.
 */
describe('Admin dashboard stats (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const http = () => actors.http();
  const db = () => actors.db;

  let superAdmin: Actor;
  let client: Actor;
  /** Workspaces moved to just before/after Dhaka midnights in 2024 (a leap year). */
  const edge: Record<string, Actor> = {};
  const EDGES = {
    // Dhaka 2024-01-31 23:59:59.999 / 2024-02-01 00:00 (month edge)
    janLast: '2024-01-31T17:59:59.999Z',
    febFirst: '2024-01-31T18:00:00.000Z',
    // Dhaka 2024-02-28 23:59:59.999 / 2024-02-29 00:00 (leap day)
    feb28: '2024-02-28T17:59:59.999Z',
    feb29: '2024-02-28T18:00:00.000Z',
    // Dhaka 2024-03-31 23:59:59.999 / 2024-04-01 00:00 (month edge)
    marLast: '2024-03-31T17:59:59.999Z',
    aprFirst: '2024-03-31T18:00:00.000Z',
  } as const;

  async function stats(query: string, cookie = superAdmin.cookie) {
    const res = await http()
      .get(`${STATS}${query ? `?${query}` : ''}`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body as DashboardStatsResponse;
  }
  const growthByBucket = (s: DashboardStatsResponse) =>
    Object.fromEntries(
      s.series.growth.map((p) => [p.bucket, [p.newClients, p.totalClients]]),
    );
  async function dbCount(status?: 'ACTIVE') {
    const [row] = await db()
      .select({ n: count() })
      .from(workspaces)
      .where(status ? eq(workspaces.status, status) : undefined);
    return row!.n;
  }

  /** Full response shape with zero-filled placeholders and no nulls. */
  function expectShape(
    s: DashboardStatsResponse,
    buckets: number,
    planTiers: DashboardStatsResponse['series']['planTiers'] = [],
  ) {
    expect(Object.keys(s).sort()).toEqual(
      [
        'from',
        'granularity',
        'kpis',
        'range',
        'series',
        'timezone',
        'to',
      ].sort(),
    );
    expect(s.timezone).toBe('Asia/Dhaka');
    expect(s.kpis).toEqual({
      activeClients: expect.any(Number) as number,
      mrrBdt: 0,
      commentsScanned: 0,
      openTickets: expect.any(Number) as number,
    });
    expect(s.series.growth).toHaveLength(buckets);
    const keys = s.series.growth.map((p) => p.bucket);
    expect(new Set(keys).size).toBe(buckets);
    expect([...keys].sort()).toEqual(keys);
    expect(s.series.comments).toEqual(
      keys.map((bucket) => ({ bucket, scanned: 0, blocked: 0 })),
    );
    for (const p of s.series.growth) {
      expect(p).toEqual({
        bucket: expect.any(String) as string,
        newClients: expect.any(Number) as number,
        totalClients: expect.any(Number) as number,
        mrrBdt: 0,
      });
    }
    expect(s.series.planTiers).toEqual(planTiers);
    expect(s.series.gateways).toEqual([]);
    expect(JSON.stringify(s)).not.toContain('null');
  }

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m2t5-super');
    client = await actors.signUp('m2t5-client');
    for (const [name, at] of Object.entries(EDGES)) {
      const actor = await actors.signUp(`m2t5-${name.toLowerCase()}`);
      await db()
        .update(workspaces)
        .set({ createdAt: new Date(at) })
        .where(eq(workspaces.id, actor.workspaceId));
      edge[name] = actor;
    }
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('access', () => {
    it('401 when signed out', async () => {
      const res = await http().get(STATS).expect(401);
      expect(res.body).toMatchObject({ statusCode: 401, path: STATS });
    });

    it('403 for a normal user (workspace owner)', async () => {
      const res = await http()
        .get(STATS)
        .set('Cookie', client.cookie)
        .expect(403);
      expect(res.body).toMatchObject({ message: 'Super admin only' });
    });

    it('403 for impersonated sessions (super admin or client)', async () => {
      const adminCookie = await actors.signIn(superAdmin.email);
      await actors.patchStoredSession(adminCookie, {
        impersonatedBy: superAdmin.id,
      });
      const ownerCookie = await actors.signIn(client.email);
      await actors.patchStoredSession(ownerCookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: client.workspaceId,
      });
      for (const cookie of [adminCookie, ownerCookie]) {
        await http().get(STATS).set('Cookie', cookie).expect(403);
      }
    });
  });

  describe('presets', () => {
    const today = () => dhakaBucketKey(new Date(), 'day');

    it('defaults to 30d (daily, ending today in Dhaka)', async () => {
      const s = await stats('');
      expectShape(s, 30);
      expect(s).toMatchObject({
        range: '30d',
        granularity: 'day',
        to: today(),
      });
      expect(s.series.growth.at(-1)!.bucket).toBe(today());
      expect(s.series.growth[0]!.bucket).toBe(s.from);
      // Wired in M2-T7 (seeded counts are covered in admin-tickets.e2e-spec.ts).
      const [open] = await db()
        .select({ n: count() })
        .from(tickets)
        .where(inArray(tickets.status, [...UNRESOLVED_TICKET_STATUSES]));
      expect(s.kpis.openTickets).toBe(open!.n);
    });

    it.each([
      ['7d', 7],
      ['30d', 30],
      ['90d', 90],
    ] as const)('%s → %i daily buckets', async (range, n) => {
      const s = await stats(`range=${range}`);
      expectShape(s, n);
      expect(s).toMatchObject({ range, granularity: 'day', to: today() });
      expect(s.series.growth[0]!.bucket).toBe(s.from);
      expect(s.series.growth.at(-1)!.bucket).toBe(today());
      // Every existing workspace was created by now.
      expect(s.series.growth.at(-1)!.totalClients).toBe(await dbCount());
      // This spec's super admin + client signed up today.
      expect(s.series.growth.at(-1)!.newClients).toBeGreaterThanOrEqual(2);
    });

    it('12m → 12 monthly buckets ending this Dhaka month', async () => {
      const s = await stats('range=12m');
      expectShape(s, 12);
      expect(s).toMatchObject({
        range: '12m',
        granularity: 'month',
        to: today(),
      });
      expect(s.from).toMatch(/^\d{4}-\d{2}-01$/);
      expect(s.series.growth[0]!.bucket).toBe(s.from.slice(0, 7));
      expect(s.series.growth.at(-1)!.bucket).toBe(today().slice(0, 7));
      expect(s.series.growth.at(-1)!.totalClients).toBe(await dbCount());
    });

    it('activeClients = ACTIVE workspaces right now; growth counts any status', async () => {
      const before = await stats('range=7d');
      expect(before.kpis.activeClients).toBe(await dbCount('ACTIVE'));
      await db()
        .update(workspaces)
        .set({ status: 'SUSPENDED' })
        .where(eq(workspaces.id, client.workspaceId));
      try {
        const after = await stats('range=7d');
        expect(after.kpis.activeClients).toBe(before.kpis.activeClients - 1);
        expect(after.series.growth).toEqual(before.series.growth);
      } finally {
        await db()
          .update(workspaces)
          .set({ status: 'ACTIVE' })
          .where(eq(workspaces.id, client.workspaceId));
      }
    });
  });

  describe('custom range + Dhaka buckets', () => {
    it('daily: rows land in the Dhaka day (17:59:59.999Z vs 18:00Z, leap day, month edges)', async () => {
      const s = await stats('from=2024-02-01&to=2024-03-31');
      expectShape(s, 60);
      expect(s).toMatchObject({
        range: 'custom',
        granularity: 'day',
        from: '2024-02-01',
        to: '2024-03-31',
      });
      const g = growthByBucket(s);
      // janLast (Dhaka 01-31) is before the range: it only seeds the running total.
      expect(g['2024-02-01']).toEqual([1, 2]); // febFirst
      expect(g['2024-02-28']).toEqual([1, 3]); // feb28
      expect(g['2024-02-29']).toEqual([1, 4]); // feb29
      expect(g['2024-03-30']).toEqual([0, 4]);
      expect(g['2024-03-31']).toEqual([1, 5]); // marLast; aprFirst is outside
      expect(s.series.growth.reduce((sum, p) => sum + p.newClients, 0)).toBe(4);
    });

    it('single leap day', async () => {
      const s = await stats('from=2024-02-29&to=2024-02-29');
      expectShape(s, 1);
      expect(s.series.growth).toEqual([
        { bucket: '2024-02-29', newClients: 1, totalClients: 4, mrrBdt: 0 },
      ]);
    });

    it('monthly (> 92 days): rows land in the Dhaka month', async () => {
      const s = await stats('from=2023-06-01&to=2024-05-31');
      expectShape(s, 12);
      expect(s).toMatchObject({ range: 'custom', granularity: 'month' });
      const g = growthByBucket(s);
      expect(g['2023-12']).toEqual([0, 0]);
      expect(g['2024-01']).toEqual([1, 1]); // janLast
      expect(g['2024-02']).toEqual([3, 4]); // febFirst, feb28, feb29
      expect(g['2024-03']).toEqual([1, 5]); // marLast
      expect(g['2024-04']).toEqual([1, 6]); // aprFirst
      expect(g['2024-05']).toEqual([0, 6]);
    });
  });

  /** M2-T12b: ACTIVE workspaces per plan now (only plans with ≥ 1, by sortOrder, tier = name). */
  describe('planTiers', () => {
    const setPlan = (actors_: Actor[], planId: string | null) =>
      db()
        .update(workspaces)
        .set({ planId })
        .where(
          inArray(
            workspaces.id,
            actors_.map((x) => x.workspaceId),
          ),
        );

    it('is [] while no workspace has a plan', async () => {
      const [withPlan] = await db()
        .select({ n: count() })
        .from(workspaces)
        .innerJoin(plans, eq(plans.id, workspaces.planId));
      expect(withPlan!.n).toBe(0);
      expect((await stats('range=7d')).series.planTiers).toEqual([]);
    });

    it('counts ACTIVE workspaces per plan, ordered by sortOrder, for any range', async () => {
      const rows = await db()
        .select({ id: plans.id, slug: plans.slug, name: plans.name })
        .from(plans)
        .orderBy(asc(plans.sortOrder), asc(plans.name));
      expect(rows.map((r) => r.slug)).toEqual([
        'free',
        'starter',
        'growth',
        'pro',
      ]);
      const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
      const all = [client, ...Object.values(edge)];
      try {
        // Growth ×3 (inserted before Starter on purpose), Pro ×1, Starter ×1; the only Free
        // workspace is SUSPENDED (not counted) and aprFirst has no plan.
        await setPlan(
          [edge.janLast!, edge.febFirst!, client],
          bySlug.growth!.id,
        );
        await setPlan([edge.feb29!], bySlug.pro!.id);
        await setPlan([edge.feb28!], bySlug.starter!.id);
        await setPlan([edge.marLast!], bySlug.free!.id);
        await db()
          .update(workspaces)
          .set({ status: 'SUSPENDED' })
          .where(eq(workspaces.id, edge.marLast!.workspaceId));

        const expected = [
          { tier: bySlug.starter!.name, clients: 1 },
          { tier: bySlug.growth!.name, clients: 3 },
          { tier: bySlug.pro!.name, clients: 1 },
        ];
        expectShape(await stats('range=7d'), 7, expected);
        expectShape(await stats('range=12m'), 12, expected);
        expectShape(await stats('from=2024-02-29&to=2024-02-29'), 1, expected);

        // A suspended Growth client drops out; a plan whose last client goes is omitted.
        await db()
          .update(workspaces)
          .set({ status: 'SUSPENDED' })
          .where(eq(workspaces.id, client.workspaceId));
        await setPlan([edge.feb29!], null);
        expect((await stats('range=7d')).series.planTiers).toEqual([
          { tier: bySlug.starter!.name, clients: 1 },
          { tier: bySlug.growth!.name, clients: 2 },
        ]);
      } finally {
        await setPlan(all, null);
        await db()
          .update(workspaces)
          .set({ status: 'ACTIVE' })
          .where(
            inArray(
              workspaces.id,
              all.map((x) => x.workspaceId),
            ),
          );
      }
      expect((await stats('range=7d')).series.planTiers).toEqual([]);
    });
  });

  describe('validation', () => {
    it.each([
      ['unknown range', 'range=1y'],
      ['range + from/to', 'range=7d&from=2024-02-01&to=2024-02-02'],
      ['only from', 'from=2024-02-01'],
      ['only to', 'to=2024-02-01'],
      ['from > to', 'from=2024-03-02&to=2024-03-01'],
      ['too long a span (25 months)', 'from=2022-01-01&to=2024-01-31'],
      ['impossible date', 'from=2024-02-30&to=2024-03-01'],
      [
        'date-time instead of a date',
        'from=2024-02-01T00:00:00Z&to=2024-02-02',
      ],
      ['before 2020-01-01', 'from=2019-12-01&to=2020-01-31'],
      ['to in the future', 'from=2026-01-01&to=2099-01-01'],
      ['unknown parameter', 'range=7d&granularity=day'],
    ])('400 for %s', async (_label, query) => {
      const res = await http()
        .get(`${STATS}?${query}`)
        .set('Cookie', superAdmin.cookie)
        .expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    });
  });
});
