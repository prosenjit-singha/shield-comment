import { BadRequestException } from '@nestjs/common';
import {
  addDays,
  bucketKeys,
  dhakaBucketKey,
  dhakaMidnight,
  resolveDashboardRange,
} from './dashboard-range.js';

/** 2026-11-18 10:00 Dhaka. */
const NOW = new Date('2026-11-18T04:00:00Z');

describe('dhakaBucketKey (Asia/Dhaka = UTC+6)', () => {
  it('cuts days at Dhaka midnight: 17:59:59.999Z vs 18:00Z', () => {
    expect(dhakaBucketKey(new Date('2026-11-17T17:59:59.999Z'), 'day')).toBe(
      '2026-11-17',
    );
    expect(dhakaBucketKey(new Date('2026-11-17T18:00:00.000Z'), 'day')).toBe(
      '2026-11-18',
    );
  });

  it('cuts months at Dhaka midnight on the 1st', () => {
    expect(dhakaBucketKey(new Date('2026-01-31T17:59:59.999Z'), 'month')).toBe(
      '2026-01',
    );
    expect(dhakaBucketKey(new Date('2026-01-31T18:00:00Z'), 'month')).toBe(
      '2026-02',
    );
    // New year in Dhaka while UTC is still in December.
    expect(dhakaBucketKey(new Date('2025-12-31T18:00:00Z'), 'month')).toBe(
      '2026-01',
    );
    expect(dhakaBucketKey(new Date('2025-12-31T18:00:00Z'), 'day')).toBe(
      '2026-01-01',
    );
  });

  it('handles leap days', () => {
    expect(dhakaBucketKey(new Date('2028-02-28T18:00:00Z'), 'day')).toBe(
      '2028-02-29',
    );
    expect(dhakaBucketKey(new Date('2028-02-29T17:59:59.999Z'), 'day')).toBe(
      '2028-02-29',
    );
    expect(dhakaBucketKey(new Date('2028-02-29T18:00:00Z'), 'day')).toBe(
      '2028-03-01',
    );
    expect(dhakaBucketKey(new Date('2027-02-28T18:00:00Z'), 'day')).toBe(
      '2027-03-01',
    );
  });

  it('dhakaMidnight is 18:00 UTC the day before', () => {
    expect(dhakaMidnight('2026-11-18').toISOString()).toBe(
      '2026-11-17T18:00:00.000Z',
    );
    expect(dhakaMidnight('2028-03-01').toISOString()).toBe(
      '2028-02-29T18:00:00.000Z',
    );
  });

  it('addDays crosses month, year and leap-day edges', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('resolveDashboardRange: presets', () => {
  it('defaults to 30d: 30 Dhaka days ending today, daily', () => {
    const r = resolveDashboardRange({}, NOW);
    expect(r).toMatchObject({
      range: '30d',
      granularity: 'day',
      from: '2026-10-20',
      to: '2026-11-18',
    });
    expect(r.start.toISOString()).toBe('2026-10-19T18:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-18T18:00:00.000Z');
    expect(bucketKeys(r)).toHaveLength(30);
  });

  it.each([
    ['7d', 7, '2026-11-12'],
    ['30d', 30, '2026-10-20'],
    ['90d', 90, '2026-08-21'],
  ] as const)('%s = %i daily buckets from %s', (range, n, from) => {
    const r = resolveDashboardRange({ range }, NOW);
    expect(r).toMatchObject({
      range,
      granularity: 'day',
      from,
      to: '2026-11-18',
    });
    const keys = bucketKeys(r);
    expect(keys).toHaveLength(n);
    expect(keys[0]).toBe(from);
    expect(keys.at(-1)).toBe('2026-11-18');
  });

  it('12m = current Dhaka month + the 11 before, monthly', () => {
    const r = resolveDashboardRange({ range: '12m' }, NOW);
    expect(r).toMatchObject({
      range: '12m',
      granularity: 'month',
      from: '2025-12-01',
      to: '2026-11-18',
    });
    const keys = bucketKeys(r);
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe('2025-12');
    expect(keys.at(-1)).toBe('2026-11');
    expect(r.start.toISOString()).toBe('2025-11-30T18:00:00.000Z');
  });

  it('"today" is the Dhaka date, not the UTC date', () => {
    // 2026-11-18 23:30 UTC = 2026-11-19 05:30 Dhaka.
    const late = new Date('2026-11-18T23:30:00Z');
    expect(resolveDashboardRange({ range: '7d' }, late).to).toBe('2026-11-19');
    // 2026-11-30 18:00 UTC = 2026-12-01 00:00 Dhaka: 12m moves to Jan..Dec.
    const r = resolveDashboardRange(
      { range: '12m' },
      new Date('2026-11-30T18:00:00Z'),
    );
    expect(bucketKeys(r)[0]).toBe('2026-01');
    expect(bucketKeys(r).at(-1)).toBe('2026-12');
  });

  it('7d across a leap day', () => {
    const r = resolveDashboardRange(
      { range: '7d' },
      new Date('2028-03-02T06:00:00Z'),
    );
    expect(bucketKeys(r)).toEqual([
      '2028-02-25',
      '2028-02-26',
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
      '2028-03-02',
    ]);
  });
});

describe('resolveDashboardRange: custom from/to', () => {
  it('a single day is one daily bucket', () => {
    const r = resolveDashboardRange(
      { from: '2026-11-18', to: '2026-11-18' },
      NOW,
    );
    expect(r).toMatchObject({ range: 'custom', granularity: 'day' });
    expect(bucketKeys(r)).toEqual(['2026-11-18']);
    expect(r.end.getTime() - r.start.getTime()).toBe(86_400_000);
  });

  it('≤ 92 days is daily, 93+ days is monthly', () => {
    const daily = resolveDashboardRange(
      { from: '2026-01-01', to: '2026-04-02' }, // 92 days
      NOW,
    );
    expect(daily.granularity).toBe('day');
    expect(bucketKeys(daily)).toHaveLength(92);
    const monthly = resolveDashboardRange(
      { from: '2026-01-01', to: '2026-04-03' }, // 93 days
      NOW,
    );
    expect(monthly.granularity).toBe('month');
    expect(bucketKeys(monthly)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
  });

  it('monthly buckets include the partial first and last month', () => {
    const r = resolveDashboardRange(
      { from: '2024-01-15', to: '2024-06-10' },
      NOW,
    );
    expect(bucketKeys(r)).toEqual([
      '2024-01',
      '2024-02',
      '2024-03',
      '2024-04',
      '2024-05',
      '2024-06',
    ]);
    expect(r.start.toISOString()).toBe('2024-01-14T18:00:00.000Z');
    expect(r.end.toISOString()).toBe('2024-06-10T18:00:00.000Z');
  });

  it('daily buckets through a leap February', () => {
    const r = resolveDashboardRange(
      { from: '2024-02-27', to: '2024-03-01' },
      NOW,
    );
    expect(bucketKeys(r)).toEqual([
      '2024-02-27',
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
  });

  it('allows up to 24 calendar months and to = today', () => {
    const r = resolveDashboardRange(
      { from: '2024-12-01', to: '2026-11-18' },
      NOW,
    );
    expect(bucketKeys(r)).toHaveLength(24);
  });

  const bad = (query: Parameters<typeof resolveDashboardRange>[0]) => () =>
    resolveDashboardRange(query, NOW);

  it.each([
    [
      'range together with from/to',
      { range: '7d' as const, from: '2026-11-01', to: '2026-11-02' },
    ],
    ['only from', { from: '2026-11-01' }],
    ['only to', { to: '2026-11-01' }],
    ['impossible date', { from: '2026-02-30', to: '2026-03-01' }],
    ['Feb 29 in a common year', { from: '2026-02-29', to: '2026-03-01' }],
    ['month 13', { from: '2026-01-01', to: '2026-13-01' }],
    ['from after to', { from: '2026-11-02', to: '2026-11-01' }],
    ['before 2020-01-01', { from: '2019-12-31', to: '2020-01-31' }],
    ['to after today (Dhaka)', { from: '2026-11-01', to: '2026-11-19' }],
    ['25 calendar months', { from: '2024-11-30', to: '2026-11-01' }],
  ])('400 for %s', (_label, query) => {
    expect(bad(query)).toThrow(BadRequestException);
  });

  it('Feb 29 in a leap year is a valid date', () => {
    expect(bad({ from: '2024-02-29', to: '2024-02-29' })).not.toThrow();
  });
});
