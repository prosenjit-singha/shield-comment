import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { resolveDashboardRange } from './dashboard-range.js';
import {
  buildDashboardStats,
  bucketEnd,
  commentsPoint,
  type MrrSubscription,
  mrrAt,
  planTierSlices,
} from './dashboard-stats.js';
import { DashboardStatsQueryDto } from './dto/dashboard-stats.dto.js';

const NOW = new Date('2026-11-18T04:00:00Z');

describe('commentsPoint (M5-T13, D14)', () => {
  it('scanned = classified, blocked = hidden + deleted', () => {
    expect(
      commentsPoint('2026-11-18', { classified: 9, hidden: 3, deleted: 2 }),
    ).toEqual({ bucket: '2026-11-18', scanned: 9, blocked: 5 });
  });

  it('a bucket without stats is zeros', () => {
    expect(commentsPoint('2026-11', undefined)).toEqual({
      bucket: '2026-11',
      scanned: 0,
      blocked: 0,
    });
  });
});

describe('buildDashboardStats', () => {
  it('fills comments from the per-bucket sums; the KPI is the range total', () => {
    const range = resolveDashboardRange({ range: '7d' }, NOW);
    const stats = buildDashboardStats(range, {
      activeClients: 0,
      clientsBefore: 0,
      openTickets: 0,
      newClients: {},
      planTiers: [],
      comments: {
        '2026-11-12': { classified: 4, hidden: 1, deleted: 0 },
        '2026-11-18': { classified: 6, hidden: 2, deleted: 1 },
        // Outside the range: ignored.
        '2026-11-11': { classified: 100, hidden: 100, deleted: 100 },
      },
    });
    expect(stats.kpis.commentsScanned).toBe(10);
    expect(stats.series.comments[0]).toEqual({
      bucket: '2026-11-12',
      scanned: 4,
      blocked: 1,
    });
    expect(stats.series.comments[6]).toEqual({
      bucket: '2026-11-18',
      scanned: 6,
      blocked: 3,
    });
    expect(
      stats.series.comments.slice(1, 6).every((p) => p.scanned === 0),
    ).toBe(true);
  });

  it('zero-fills every daily bucket and keeps a running client total', () => {
    const range = resolveDashboardRange({ range: '7d' }, NOW);
    const stats = buildDashboardStats(range, {
      activeClients: 4,
      clientsBefore: 10,
      openTickets: 3,
      newClients: { '2026-11-13': 2, '2026-11-18': 1 },
      planTiers: [],
    });
    expect(stats).toMatchObject({
      range: '7d',
      granularity: 'day',
      timezone: 'Asia/Dhaka',
      from: '2026-11-12',
      to: '2026-11-18',
      kpis: { activeClients: 4, mrrBdt: 0, commentsScanned: 0, openTickets: 3 },
    });
    expect(stats.series.growth).toEqual([
      { bucket: '2026-11-12', newClients: 0, totalClients: 10, mrrBdt: 0 },
      { bucket: '2026-11-13', newClients: 2, totalClients: 12, mrrBdt: 0 },
      { bucket: '2026-11-14', newClients: 0, totalClients: 12, mrrBdt: 0 },
      { bucket: '2026-11-15', newClients: 0, totalClients: 12, mrrBdt: 0 },
      { bucket: '2026-11-16', newClients: 0, totalClients: 12, mrrBdt: 0 },
      { bucket: '2026-11-17', newClients: 0, totalClients: 12, mrrBdt: 0 },
      { bucket: '2026-11-18', newClients: 1, totalClients: 13, mrrBdt: 0 },
    ]);
    expect(stats.series.comments).toEqual(
      stats.series.growth.map(({ bucket }) => ({
        bucket,
        scanned: 0,
        blocked: 0,
      })),
    );
    expect(stats.series.planTiers).toEqual([]);
    expect(stats.series.gateways).toEqual([]);
  });

  it('monthly buckets, empty database: all zeros, no nulls', () => {
    const range = resolveDashboardRange({ range: '12m' }, NOW);
    const stats = buildDashboardStats(range, {
      activeClients: 0,
      clientsBefore: 0,
      openTickets: 0,
      newClients: {},
      planTiers: [],
    });
    expect(stats.series.growth).toHaveLength(12);
    expect(stats.series.comments).toHaveLength(12);
    expect(JSON.stringify(stats)).not.toContain('null');
    for (const p of stats.series.growth)
      expect(p).toEqual({
        bucket: expect.stringMatching(/^\d{4}-\d{2}$/) as string,
        newClients: 0,
        totalClients: 0,
        mrrBdt: 0,
      });
  });

  it('ignores counts for keys outside the range', () => {
    const range = resolveDashboardRange(
      { from: '2026-11-01', to: '2026-11-02' },
      NOW,
    );
    const stats = buildDashboardStats(range, {
      activeClients: 1,
      clientsBefore: 0,
      openTickets: 0,
      newClients: { '2026-10-31': 5, '2026-11-02': 1 },
      planTiers: [],
    });
    expect(stats.series.growth.map((p) => p.totalClients)).toEqual([0, 1]);
  });
});

describe('MRR (M8-T8, reading 13)', () => {
  const d = (iso: string) => new Date(iso);
  const sub = (over: Partial<MrrSubscription>): MrrSubscription => ({
    status: 'ACTIVE',
    interval: 'month',
    chargedBdt: 499,
    currentTermStart: d('2026-11-01T00:00:00Z'),
    currentTermEnd: d('2026-12-01T00:00:00Z'),
    canceledAt: null,
    scheduledInterval: null,
    scheduledChargedBdt: null,
    ...over,
  });

  it('monthly = charged, yearly = charged ÷ 12, summed then rounded', () => {
    const subs = [
      sub({}),
      sub({ interval: 'year', chargedBdt: 5388 }), // 449
      sub({ interval: 'year', chargedBdt: 1000 }), // 83.33…
      sub({ interval: 'year', chargedBdt: 1000 }), // 83.33… → 666.67 total
    ];
    expect(mrrAt(subs, NOW)).toBe(499 + 449 + 167);
  });

  it('counts a term only inside [start, canceled_at ?? end)', () => {
    const later = d('2026-12-05T00:00:00Z');
    const subs = [
      sub({ status: 'EXPIRED' }),
      sub({ status: 'CANCELED', canceledAt: d('2026-11-10T00:00:00Z') }),
    ];
    expect(mrrAt(subs, d('2026-10-31T23:59:59Z'), later)).toBe(0);
    expect(mrrAt(subs, d('2026-11-01T00:00:00Z'), later)).toBe(998);
    expect(mrrAt(subs, d('2026-11-10T00:00:00Z'), later)).toBe(499);
    expect(mrrAt(subs, d('2026-12-01T00:00:00Z'), later)).toBe(0);
  });

  it('now: only live ACTIVE rows (TRIALING never; EXPIRED / CANCELED ended by now)', () => {
    const subs = [sub({}), sub({ status: 'EXPIRED' })];
    expect(mrrAt(subs, NOW, NOW)).toBe(499);
    // Before now the early-expired row still counts (when it expired is not stored).
    expect(mrrAt(subs, d('2026-11-17T00:00:00Z'), NOW)).toBe(998);
  });

  it('M8-D7b: a still-ACTIVE row reads as its scheduled term for 28 days past the end', () => {
    const scheduled = sub({
      interval: 'year',
      chargedBdt: 5388,
      scheduledInterval: 'month',
      scheduledChargedBdt: 299,
    });
    expect(mrrAt([scheduled], d('2026-11-30T00:00:00Z'))).toBe(449);
    expect(mrrAt([scheduled], d('2026-12-01T00:00:00Z'))).toBe(299);
    expect(mrrAt([scheduled], d('2026-12-29T00:00:00Z'))).toBe(0);
    // After the switch the old row is EXPIRED (it keeps scheduled_*): not counted twice.
    expect(
      mrrAt([{ ...scheduled, status: 'EXPIRED' }], d('2026-12-01T00:00:00Z')),
    ).toBe(0);
  });

  it('bucketEnd = next Dhaka midnight (day) or next month start (month)', () => {
    expect(bucketEnd('2026-11-18', 'day').toISOString()).toBe(
      '2026-11-18T18:00:00.000Z',
    );
    expect(bucketEnd('2026-12', 'month').toISOString()).toBe(
      '2026-12-31T18:00:00.000Z',
    );
  });

  it('KPI = MRR now; each growth point = MRR at its bucket end (now for the last)', () => {
    const range = resolveDashboardRange({ range: '7d' }, NOW); // 2026-11-12 … 2026-11-18
    const stats = buildDashboardStats(range, {
      activeClients: 0,
      clientsBefore: 0,
      openTickets: 0,
      newClients: {},
      planTiers: [],
      mrr: {
        now: NOW,
        subscriptions: [
          // From 2026-11-14 00:00 Dhaka.
          sub({ currentTermStart: d('2026-11-13T18:00:00Z') }),
          // Starts after NOW: not in the KPI nor the last bucket.
          sub({ currentTermStart: d('2026-11-18T05:00:00Z') }),
        ],
      },
      gateways: [{ gateway: 'bKash', amountBdt: 998, transactions: 2 }],
    });
    expect(stats.kpis.mrrBdt).toBe(499);
    expect(stats.series.growth.map((p) => p.mrrBdt)).toEqual([
      0, 0, 499, 499, 499, 499, 499,
    ]);
    expect(stats.series.gateways).toEqual([
      { gateway: 'bKash', amountBdt: 998, transactions: 2 },
    ]);
  });
});

describe('planTierSlices', () => {
  it('keeps plans with ≥ 1 client, ordered by sortOrder then name, tier = plan name', () => {
    expect(
      planTierSlices([
        { name: 'Pro', sortOrder: 3, clients: 1 },
        { name: 'Free', sortOrder: 0, clients: 0 },
        { name: 'Starter', sortOrder: 1, clients: 4 },
        { name: 'Growth', sortOrder: 2, clients: 2 },
        { name: 'Agency', sortOrder: 2, clients: 1 },
      ]),
    ).toEqual([
      { tier: 'Starter', clients: 4 },
      { tier: 'Agency', clients: 1 },
      { tier: 'Growth', clients: 2 },
      { tier: 'Pro', clients: 1 },
    ]);
  });

  it('is [] (never null) when no workspace has a plan', () => {
    expect(planTierSlices([])).toEqual([]);
    expect(
      planTierSlices([{ name: 'Free', sortOrder: 0, clients: 0 }]),
    ).toEqual([]);
  });

  it('feeds series.planTiers', () => {
    const range = resolveDashboardRange({ range: '7d' }, NOW);
    const stats = buildDashboardStats(range, {
      activeClients: 3,
      clientsBefore: 0,
      openTickets: 0,
      newClients: {},
      planTiers: [
        { name: 'Growth', sortOrder: 2, clients: 2 },
        { name: 'Free', sortOrder: 0, clients: 1 },
      ],
    });
    expect(stats.series.planTiers).toEqual([
      { tier: 'Free', clients: 1 },
      { tier: 'Growth', clients: 2 },
    ]);
  });
});

describe('DashboardStatsQueryDto', () => {
  async function fields(plain: Record<string, unknown>) {
    const errors = await validate(
      plainToInstance(DashboardStatsQueryDto, plain),
      {
        whitelist: true,
        forbidNonWhitelisted: true,
      },
    );
    return errors.map((e) => e.property);
  }

  it('accepts nothing, each preset, or from/to dates', async () => {
    expect(await fields({})).toEqual([]);
    for (const range of ['7d', '30d', '90d', '12m'])
      expect(await fields({ range })).toEqual([]);
    expect(await fields({ from: '2026-01-01', to: '2026-01-31' })).toEqual([]);
  });

  it.each([
    [{ range: '1y' }, ['range']],
    [{ range: '' }, ['range']],
    [{ from: '2026-1-1', to: '2026-01-31' }, ['from']],
    [{ from: '2026-01-01T00:00:00+06:00', to: '2026-01-31' }, ['from']],
    [{ from: '2026-01-01', to: ['2026-01-31', '2026-02-01'] }, ['to']],
    [{ granularity: 'day' }, ['granularity']],
  ])('rejects %j', async (plain, expected) => {
    expect(await fields(plain)).toEqual(expected);
  });
});
