import {
  assertCreditCost,
  dhakaMonthKey,
  MAX_CREDIT_COST,
} from './credit-period.js';

describe('dhakaMonthKey (Asia/Dhaka = UTC+6, D15)', () => {
  it('switches month at 00:00 Dhaka on the 1st (18:00Z on the last day)', () => {
    expect(dhakaMonthKey(new Date('2026-11-30T17:59:59.999Z'))).toBe('2026-11');
    expect(dhakaMonthKey(new Date('2026-11-30T18:00:00.000Z'))).toBe('2026-12');
  });

  it('rolls the year over and handles February', () => {
    expect(dhakaMonthKey(new Date('2026-12-31T17:59:59.999Z'))).toBe('2026-12');
    expect(dhakaMonthKey(new Date('2026-12-31T18:00:00.000Z'))).toBe('2027-01');
    expect(dhakaMonthKey(new Date('2028-02-28T18:00:00.000Z'))).toBe('2028-02');
    expect(dhakaMonthKey(new Date('2028-02-29T18:00:00.000Z'))).toBe('2028-03');
  });

  it('the first Dhaka hours of a month are still the previous UTC day', () => {
    // 2026-11-01 05:59 Dhaka = 2026-10-31 23:59Z.
    expect(dhakaMonthKey(new Date('2026-10-31T23:59:00.000Z'))).toBe('2026-11');
  });

  it('defaults to now and rejects an invalid date', () => {
    expect(dhakaMonthKey()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(() => dhakaMonthKey(new Date('nope'))).toThrow(RangeError);
  });
});

describe('assertCreditCost', () => {
  it.each([1, 2, MAX_CREDIT_COST])('accepts %j', (cost) => {
    expect(() => assertCreditCost(cost)).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, MAX_CREDIT_COST + 1])(
    'rejects %j',
    (cost) => {
      expect(() => assertCreditCost(cost)).toThrow(RangeError);
    },
  );
});
