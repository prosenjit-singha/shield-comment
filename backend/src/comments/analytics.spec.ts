import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DAILY_COMMENT_COUNTERS } from '../db/schema/index.js';
import {
  analyticsRange,
  buildAnalytics,
  COMMENTS_CSV_HEADER,
  commentsCsv,
  COMMENTS_CSV_MAX_DAYS,
  csvRange,
  DAILY_CSV_HEADER,
  DAILY_CSV_MAX_DAYS,
  dailyStatsCsv,
  dhakaDateTime,
} from './analytics.js';
import { AnalyticsQueryDto } from './dto/analytics.dto.js';

/** 2026-11-20 23:59:59.999 Dhaka. */
const NOW = new Date('2026-11-20T17:59:59.999Z');

const rangeError = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).message;
  }
  throw new Error('expected a 400');
};

describe('analytics ranges (M6-T6, D11/D12)', () => {
  it('defaults to the last 30 Dhaka days, daily', () => {
    const r = analyticsRange({}, NOW);
    expect(r).toMatchObject({
      from: '2026-10-22',
      to: '2026-11-20',
      granularity: 'day',
    });
  });

  it('daily up to 92 days, monthly from 93', () => {
    expect(
      analyticsRange({ from: '2026-08-21', to: '2026-11-20' }, NOW).granularity,
    ).toBe('day');
    expect(
      analyticsRange({ from: '2026-08-20', to: '2026-11-20' }, NOW).granularity,
    ).toBe('month');
  });

  it('caps analytics at 12 calendar months', () => {
    expect(
      analyticsRange({ from: '2025-12-01', to: '2026-11-20' }, NOW).granularity,
    ).toBe('month');
    expect(
      rangeError(() =>
        analyticsRange({ from: '2025-11-30', to: '2026-11-20' }, NOW),
      ),
    ).toBe('The range may cover at most 12 months');
    expect(
      rangeError(() =>
        analyticsRange({ from: '2020-01-01', to: '2026-11-20' }, NOW),
      ),
    ).toBe('The range may cover at most 12 months');
  });

  it('caps the daily CSV at 366 days and the comments CSV at 92', () => {
    expect(
      csvRange(
        { from: '2025-11-20', to: '2026-11-20' },
        NOW,
        DAILY_CSV_MAX_DAYS,
      ).from,
    ).toBe('2025-11-20');
    expect(
      rangeError(() =>
        csvRange(
          { from: '2025-11-19', to: '2026-11-20' },
          NOW,
          DAILY_CSV_MAX_DAYS,
        ),
      ),
    ).toBe('This export may cover at most 366 days');
    expect(
      csvRange(
        { from: '2026-08-21', to: '2026-11-20' },
        NOW,
        COMMENTS_CSV_MAX_DAYS,
      ).to,
    ).toBe('2026-11-20');
    expect(
      rangeError(() =>
        csvRange(
          { from: '2026-08-20', to: '2026-11-20' },
          NOW,
          COMMENTS_CSV_MAX_DAYS,
        ),
      ),
    ).toBe('This export may cover at most 92 days');
  });

  it.each([
    [{ from: '2026-11-01' }, 'from and to must be sent together'],
    [{ from: '2026-11-10', to: '2026-11-01' }, 'from must not be after to'],
    [{ from: '2026-11-01', to: '2026-11-21' }, 'to must not be after today'],
    [{ from: '2026-02-30', to: '2026-03-01' }, 'from must be a valid date'],
  ])('400 for %j', (query, message) => {
    expect(rangeError(() => analyticsRange(query, NOW))).toContain(message);
  });

  it('DTO accepts dates + a UUID pageId and rejects anything else', async () => {
    const errors = async (plain: Record<string, unknown>) =>
      (await validate(plainToInstance(AnalyticsQueryDto, plain))).map(
        (e) => e.property,
      );
    expect(
      await errors({
        from: '2026-11-01',
        to: '2026-11-20',
        pageId: '0b6f9f3e-6a3f-4c55-9a43-0c7c2b0a8e11',
      }),
    ).toEqual([]);
    expect(
      await errors({ from: '2026/11/01', to: '20261120', pageId: 'p1' }),
    ).toEqual(['from', 'to', 'pageId']);
  });
});

describe('buildAnalytics (M6-T6)', () => {
  it('zero-fills daily buckets and maps the M6-T5 counters', () => {
    const r = analyticsRange({ from: '2026-11-18', to: '2026-11-20' }, NOW);
    const a = buildAnalytics(
      r,
      {
        '2026-11-19': {
          received: 9,
          classified: 4,
          ruleMatched: 2,
          hidden: 3,
          deleted: 1,
          scamPhishing: 3,
          safeInquiry: 1,
        },
        '2026-11-17': { classified: 100 },
      },
      null,
    );
    expect(a.series.map((b) => b.bucket)).toEqual([
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
    ]);
    expect(a.series[0]).toMatchObject({
      scanned: 0,
      autoHidden: 0,
      received: 0,
    });
    expect(a.series[1]).toMatchObject({
      received: 9,
      scanned: 6,
      autoHidden: 4,
      ruleMatched: 2,
    });
    expect(a.totals).toMatchObject({
      scanned: 6,
      autoHidden: 4,
      classified: 4,
    });
    expect(Object.keys(a.totals)).toEqual([
      ...DAILY_COMMENT_COUNTERS,
      'scanned',
      'autoHidden',
    ]);
    expect(a.intents).toEqual([
      { category: 'SAFE_INQUIRY', count: 1 },
      { category: 'COMPETITOR_POACH', count: 0 },
      { category: 'SCAM_PHISHING', count: 3 },
      { category: 'SPAM_IRRELEVANT', count: 0 },
      { category: 'ABUSIVE_TOXIC', count: 0 },
    ]);
    expect(a.flagged).toEqual(a.intents.slice(1));
    expect(a.page).toBeNull();
  });

  it('sums days into zero-filled months for a long range', () => {
    const r = analyticsRange({ from: '2026-06-15', to: '2026-11-20' }, NOW);
    const a = buildAnalytics(
      r,
      {
        '2026-06-15': { classified: 1 },
        '2026-06-30': { classified: 2, hidden: 2 },
        '2026-09-01': { ruleMatched: 5 },
      },
      { id: 'p', name: 'Shop' },
    );
    expect(a.granularity).toBe('month');
    expect(a.series.map((b) => [b.bucket, b.scanned, b.autoHidden])).toEqual([
      ['2026-06', 3, 2],
      ['2026-07', 0, 0],
      ['2026-08', 0, 0],
      ['2026-09', 5, 0],
      ['2026-10', 0, 0],
      ['2026-11', 0, 0],
    ]);
    expect(a.totals.scanned).toBe(8);
    expect(a.page).toEqual({ id: 'p', name: 'Shop' });
  });
});

describe('CSV exports (M6-T6, D12 b)', () => {
  it('daily CSV: header order + every counter per day × Page × platform', () => {
    const csv = dailyStatsCsv([
      {
        day: '2026-11-20',
        pageId: '1001',
        pageName: '=Shop, "A"',
        platform: 'FACEBOOK',
        received: 3,
        hidden: 1,
      },
      {
        day: '2026-11-20',
        pageId: '1002',
        pageName: null,
        platform: 'INSTAGRAM',
      },
    ]);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(DAILY_CSV_HEADER.join(','));
    expect(lines[0]).toBe(
      'day,page_id,page_name,platform,received,edited,removed,classified,safe_inquiry,competitor_poach,scam_phishing,spam_irrelevant,abusive_toxic,rule_matched,hidden,unhidden,deleted,replied,skipped,failed',
    );
    expect(lines[1]).toBe(
      `2026-11-20,1001,"'=Shop, ""A""",FACEBOOK,3,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0`,
    );
    expect(lines[2]).toBe(
      '2026-11-20,1002,,INSTAGRAM,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0',
    );
    expect(lines[3]).toBe('');
  });

  it('comments CSV: Dhaka time, Bangla text, injection guard, empty last action', () => {
    expect(dhakaDateTime(new Date('2026-11-20T18:30:05.000Z'))).toBe(
      '2026-11-21 00:30:05',
    );
    const csv = commentsCsv([
      {
        createdAt: new Date('2026-11-20T06:00:00.000Z'),
        pageId: '1001',
        pageName: 'Shop A',
        platform: 'FACEBOOK',
        message: 'বিকাশে টাকা পাঠান, 01712345678',
        status: 'HIDDEN',
        category: 'SCAM_PHISHING',
        confidence: 0.912,
        language: 'bn',
        lastAction: 'HIDE',
        lastActionBy: 'AUTO',
        lastActionState: 'SUCCEEDED',
      },
      {
        createdAt: new Date('2026-11-20T07:00:00.000Z'),
        pageId: null,
        pageName: null,
        platform: 'INSTAGRAM',
        message: '@cmd|calc',
        status: 'PENDING',
        category: null,
        confidence: null,
        language: null,
        lastAction: null,
        lastActionBy: null,
        lastActionState: null,
      },
    ]);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(COMMENTS_CSV_HEADER.join(','));
    expect(lines[0]).not.toMatch(/author/);
    expect(lines[1]).toBe(
      '2026-11-20 12:00:00,1001,Shop A,FACEBOOK,"বিকাশে টাকা পাঠান, 01712345678",HIDDEN,SCAM_PHISHING,0.912,bn,HIDE,AUTO,SUCCEEDED',
    );
    expect(lines[2]).toBe(
      "2026-11-20 13:00:00,,,INSTAGRAM,'@cmd|calc,PENDING,,,,,,",
    );
  });
});
