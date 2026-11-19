import { dhakaDate } from './manual-activation.js';
import {
  endOfDhakaDay,
  lockedChanges,
  promotionStatus,
  promotionTermsError,
  type PromotionTerms,
} from './promotion-rules.js';

const NOW = new Date('2026-11-20T06:00:00.000Z');
const PLAN = '01a1ecf3-0000-7000-8000-000000000001';

const discount = (patch: Partial<PromotionTerms> = {}): PromotionTerms => ({
  kind: 'DISCOUNT',
  code: null,
  allPlans: false,
  planIds: [PLAN],
  trialDays: null,
  trialCommentLimit: null,
  discountType: 'FLAT',
  discountValue: 100,
  discountScope: 'PER_MONTH',
  durationMonths: null,
  ...patch,
});
const trial = (patch: Partial<PromotionTerms> = {}) =>
  discount({
    kind: 'TRIAL',
    trialDays: 7,
    discountType: null,
    discountValue: null,
    discountScope: null,
    ...patch,
  });

describe('endOfDhakaDay', () => {
  it('is the last millisecond of that Dhaka day (17:59:59.999 UTC)', () => {
    expect(endOfDhakaDay('2026-12-31').toISOString()).toBe(
      '2026-12-31T17:59:59.999Z',
    );
    expect(dhakaDate(endOfDhakaDay('2026-02-28'))).toBe('2026-02-28');
    expect(endOfDhakaDay('2026-02-28').getTime() + 1).toBe(
      Date.parse('2026-02-28T18:00:00.000Z'),
    );
  });
});

describe('promotionStatus', () => {
  const open = { stoppedAt: null, endsAt: null, maxRedemptions: null };
  it.each([
    ['live', open, 0, 'LIVE'],
    [
      'live, future end, cap left',
      { ...open, endsAt: new Date(NOW.getTime() + 1), maxRedemptions: 2 },
      1,
      'LIVE',
    ],
    ['ended (end = now)', { ...open, endsAt: NOW }, 0, 'ENDED'],
    ['used up', { ...open, maxRedemptions: 2 }, 2, 'USED_UP'],
    ['stopped', { ...open, stoppedAt: NOW }, 0, 'STOPPED'],
    // Precedence: Stopped > Ended > Used up.
    [
      'stopped + ended + used up',
      { stoppedAt: NOW, endsAt: NOW, maxRedemptions: 1 },
      1,
      'STOPPED',
    ],
    [
      'ended + used up',
      { ...open, endsAt: NOW, maxRedemptions: 1 },
      1,
      'ENDED',
    ],
  ] as const)('%s → %s', (_label, p, count, status) => {
    expect(promotionStatus(p, count, NOW)).toBe(status);
  });
});

describe('lockedChanges (reading 8)', () => {
  it('lists only money terms that are sent and differ', () => {
    const current = discount({ durationMonths: 3 });
    expect(lockedChanges(current, {})).toEqual([]);
    expect(
      lockedChanges(current, {
        discountType: 'FLAT',
        discountValue: 100,
        durationMonths: 3,
      }),
    ).toEqual([]);
    expect(
      lockedChanges(current, {
        discountValue: 200,
        durationMonths: null,
        discountScope: 'PER_MONTH',
      }),
    ).toEqual(['discountValue', 'durationMonths']);
    expect(
      lockedChanges(trial(), { trialDays: 14, trialCommentLimit: 50 }),
    ).toEqual(['trialDays', 'trialCommentLimit']);
  });
});

describe('promotionTermsError', () => {
  it.each([
    ['discount', discount()],
    [
      'percent 100, total, 3 months (ignored)',
      discount({
        discountType: 'PERCENT',
        discountValue: 100,
        discountScope: 'TOTAL',
        durationMonths: 3,
      }),
    ],
    ['flat max', discount({ discountValue: 1_000_000 })],
    ['trial with limit', trial({ trialCommentLimit: 0 })],
    ['coupon', discount({ kind: 'COUPON', code: 'SAVE10' })],
    ['all plans', discount({ allPlans: true, planIds: [] })],
  ])('accepts %s', (_label, terms) => {
    expect(promotionTermsError(terms)).toBeNull();
  });

  it.each([
    ['coupon without code', discount({ kind: 'COUPON' }), /code is required/],
    [
      'code on a discount',
      discount({ code: 'SAVE10' }),
      /only allowed on a COUPON/,
    ],
    ['code on a trial', trial({ code: 'X-1' }), /only allowed on a COUPON/],
    ['trial without days', trial({ trialDays: null }), /trialDays is required/],
    [
      'trial with a discount value',
      trial({ discountValue: 5 }),
      /discount fields/,
    ],
    ['trial with months', trial({ durationMonths: 2 }), /discount fields/],
    [
      'discount without type',
      discount({ discountType: null }),
      /required for a DISCOUNT/,
    ],
    [
      'coupon without scope',
      discount({ kind: 'COUPON', code: 'ABC', discountScope: null }),
      /required for a COUPON/,
    ],
    ['discount with trial days', discount({ trialDays: 7 }), /trial fields/],
    [
      'discount with trial limit',
      discount({ trialCommentLimit: 10 }),
      /trial fields/,
    ],
    [
      'percent above 100',
      discount({ discountType: 'PERCENT', discountValue: 101 }),
      /between 1 and 100/,
    ],
    [
      'flat above max',
      discount({ discountValue: 1_000_001 }),
      /between 1 and 1000000/,
    ],
    ['no targets', discount({ planIds: [] }), /at least one plan/],
    ['all plans + plan ids', discount({ allPlans: true }), /not both/],
  ])('rejects %s', (_label, terms, message) => {
    expect(promotionTermsError(terms)).toMatch(message);
  });
});
