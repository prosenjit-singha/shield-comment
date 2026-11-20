import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { resolveDashboardRange } from '../admin/dashboard-range.js';
import { buildDashboardSummary } from './dashboard-summary.js';
import {
  DashboardSummaryQueryDto,
  type SummaryRange,
} from './dto/dashboard-summary.dto.js';

/** 2026-11-20 23:59:59.999 Dhaka. */
const LAST_MS = new Date('2026-11-20T17:59:59.999Z');
/** 2026-11-21 00:00 Dhaka. */
const MIDNIGHT = new Date('2026-11-20T18:00:00.000Z');

const range = (preset: SummaryRange, now = LAST_MS) => ({
  ...resolveDashboardRange({ range: preset }, now),
  range: preset,
});

describe('buildDashboardSummary (M6-T5, D10)', () => {
  it('zero-fills every Dhaka day of an empty range', () => {
    const summary = buildDashboardSummary(range('7d'), {}, 0);
    expect(summary.range).toBe('7d');
    expect(summary.daily.map((d) => d.day)).toEqual([
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
    ]);
    expect(summary.daily.every((d) => d.scanned + d.autoHidden === 0)).toBe(
      true,
    );
    expect(summary.kpis).toEqual({
      scanned: 0,
      autoHidden: 0,
      needsReview: 0,
      scamsBlocked: 0,
    });
    expect(summary.intents.map((i) => [i.category, i.count])).toEqual([
      ['SAFE_INQUIRY', 0],
      ['COMPETITOR_POACH', 0],
      ['SCAM_PHISHING', 0],
      ['SPAM_IRRELEVANT', 0],
      ['ABUSIVE_TOXIC', 0],
    ]);
    expect(summary.flagged.map((i) => i.category)).toEqual([
      'COMPETITOR_POACH',
      'SCAM_PHISHING',
      'SPAM_IRRELEVANT',
      'ABUSIVE_TOXIC',
    ]);
  });

  it('scanned = classified + rule matches, autoHidden = hidden + deleted; KPIs total the range', () => {
    const summary = buildDashboardSummary(
      range('7d'),
      {
        '2026-11-14': { classified: 3, ruleMatched: 2, hidden: 1, deleted: 1 },
        '2026-11-20': {
          classified: 4,
          hidden: 2,
          safeInquiry: 1,
          scamPhishing: 5,
          abusiveToxic: 1,
        },
        // Outside the range: ignored.
        '2026-11-13': { classified: 100, scamPhishing: 100 },
      },
      7,
    );
    expect(summary.daily[0]).toEqual({
      day: '2026-11-14',
      scanned: 5,
      autoHidden: 2,
    });
    expect(summary.daily[6]).toEqual({
      day: '2026-11-20',
      scanned: 4,
      autoHidden: 2,
    });
    expect(summary.kpis).toEqual({
      scanned: 9,
      autoHidden: 4,
      needsReview: 7,
      scamsBlocked: 5,
    });
    expect(
      Object.fromEntries(summary.intents.map((i) => [i.category, i.count])),
    ).toEqual({
      SAFE_INQUIRY: 1,
      COMPETITOR_POACH: 0,
      SCAM_PHISHING: 5,
      SPAM_IRRELEVANT: 0,
      ABUSIVE_TOXIC: 1,
    });
    expect(summary.flagged).toHaveLength(4);
  });

  it('cuts days at Dhaka midnight', () => {
    expect(range('7d', LAST_MS).to).toBe('2026-11-20');
    expect(range('7d', MIDNIGHT).to).toBe('2026-11-21');
    expect(range('7d', MIDNIGHT).from).toBe('2026-11-15');
  });

  it.each([
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const)('%s has %i days', (preset, days) => {
    expect(buildDashboardSummary(range(preset), {}, 0).daily).toHaveLength(
      days,
    );
  });
});

describe('DashboardSummaryQueryDto', () => {
  const errors = async (plain: object) =>
    validate(plainToInstance(DashboardSummaryQueryDto, plain), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it.each([{}, { range: '7d' }, { range: '30d' }, { range: '90d' }])(
    'accepts %j',
    async (plain) => {
      expect(await errors(plain)).toHaveLength(0);
    },
  );

  it.each([
    { range: '12m' },
    { range: '1d' },
    { range: '' },
    { from: '2026-11-01', to: '2026-11-20' },
  ])('rejects %j', async (plain) => {
    expect(await errors(plain)).not.toHaveLength(0);
  });
});
