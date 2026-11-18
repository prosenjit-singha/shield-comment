import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { resolveDashboardRange } from './dashboard-range.js';
import { buildDashboardStats, planTierSlices } from './dashboard-stats.js';
import { DashboardStatsQueryDto } from './dto/dashboard-stats.dto.js';

const NOW = new Date('2026-11-18T04:00:00Z');

describe('buildDashboardStats', () => {
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
