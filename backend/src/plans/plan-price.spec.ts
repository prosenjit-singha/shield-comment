import {
  type PlanPriceSource,
  type PriceDiscount,
  planPrice,
} from './plan-price.js';

// Seed list prices since 0027 (PR-T1): monthly 999 / 2,499 / 5,999, yearly per month 949 / 2,349 / 5,599.
const starter: PlanPriceSource = {
  monthlyPriceBdt: 999,
  yearlyMonthlyPriceBdt: 949,
};

const flat = (
  value: number,
  patch: Partial<PriceDiscount> = {},
): PriceDiscount => ({
  promotionId: 'p-flat',
  discountType: 'FLAT',
  discountValue: value,
  discountScope: 'PER_MONTH',
  durationMonths: null,
  endsAt: null,
  ...patch,
});
const percent = (
  value: number,
  patch: Partial<PriceDiscount> = {},
): PriceDiscount =>
  flat(value, { promotionId: 'p-pct', discountType: 'PERCENT', ...patch });

describe('planPrice (PR-T2)', () => {
  it('no discount: list prices, no saving; yearly = yearly list × 12', () => {
    expect(planPrice(starter, 'month')).toEqual({
      listPerMonthBdt: 999,
      listChargedBdt: 999,
      perMonthBdt: 999,
      chargedBdt: 999,
      saving: null,
    });
    expect(planPrice(starter, 'year')).toEqual({
      listPerMonthBdt: 949,
      listChargedBdt: 11_388,
      perMonthBdt: 949,
      chargedBdt: 11_388,
      saving: null,
    });
  });

  it('seed Launch offers give today’s card prices: 499/449 · 1,499/1,349 · 3,999/3,599', () => {
    const seeds = [
      [999, 949, 500, 499, 449],
      [2499, 2349, 1000, 1499, 1349],
      [5999, 5599, 2000, 3999, 3599],
    ] as const;
    for (const [monthly, yearly, off, shownMonth, shownYear] of seeds) {
      const plan = { monthlyPriceBdt: monthly, yearlyMonthlyPriceBdt: yearly };
      const launch = [flat(off)];
      expect(planPrice(plan, 'month', launch)).toMatchObject({
        perMonthBdt: shownMonth,
        chargedBdt: shownMonth,
        saving: { amountBdt: off },
      });
      expect(planPrice(plan, 'year', launch)).toMatchObject({
        perMonthBdt: shownYear,
        chargedBdt: shownYear * 12,
        saving: { amountBdt: off * 12 },
      });
    }
  });

  it('no stacking: only the bigger first-bill saving applies (PR-D6, reading 10)', () => {
    const price = planPrice(starter, 'month', [
      flat(200, { promotionId: 'a' }),
      percent(50, { promotionId: 'b' }),
      flat(300, { promotionId: 'c' }),
    ])!;
    expect(price).toMatchObject({ perMonthBdt: 499, chargedBdt: 499 });
    expect(price.saving).toMatchObject({ promotionId: 'b', amountBdt: 500 });
  });

  it('first bill decides: a 3-month 50% beats forever ৳300 on monthly', () => {
    const price = planPrice(starter, 'month', [
      flat(300, { promotionId: 'forever' }),
      percent(50, { promotionId: 'short', durationMonths: 3 }),
    ])!;
    expect(price.saving?.promotionId).toBe('short');
  });

  it('percent price is rounded down to whole taka; flat never below ৳0', () => {
    // 999 × 0.67 = 669.33 → 669.
    expect(planPrice(starter, 'month', [percent(33)])).toMatchObject({
      chargedBdt: 669,
      saving: { amountBdt: 330 },
    });
    expect(planPrice(starter, 'month', [flat(5_000)])).toMatchObject({
      chargedBdt: 0,
      perMonthBdt: 0,
      saving: { amountBdt: 999 },
    });
    expect(planPrice(starter, 'month', [percent(100)])).toMatchObject({
      chargedBdt: 0,
    });
  });

  it('yearly × months: a PER_MONTH discount comes off N of the 12 months (reading 2)', () => {
    // 10% off 3 months of ৳949 → 3 × 854 + 9 × 949 = 11,103.
    const price = planPrice(starter, 'year', [
      percent(10, { durationMonths: 3 }),
    ])!;
    expect(price).toMatchObject({
      chargedBdt: 3 * 854 + 9 * 949,
      perMonthBdt: Math.floor((3 * 854 + 9 * 949) / 12),
      saving: { amountBdt: 3 * 95, label: '10% off for 3 months' },
    });
    // More months than the term: all 12.
    expect(
      planPrice(starter, 'year', [flat(100, { durationMonths: 24 })]),
    ).toMatchObject({ chargedBdt: 849 * 12 });
  });

  it('TOTAL ignores the month count and comes off the first bill only', () => {
    expect(
      planPrice(starter, 'year', [
        flat(1_000, { discountScope: 'TOTAL', durationMonths: 3 }),
      ]),
    ).toMatchObject({
      chargedBdt: 11_388 - 1_000,
      perMonthBdt: Math.floor(10_388 / 12),
      saving: { amountBdt: 1_000, label: '৳1,000 off' },
    });
    // Percent of the yearly bill, rounded down: floor(11,388 × 0.85) = 9,679.
    expect(
      planPrice(starter, 'year', [percent(15, { discountScope: 'TOTAL' })]),
    ).toMatchObject({ chargedBdt: 9_679 });
  });

  it('tie: the one ending sooner wins, then the lower id; no end date loses', () => {
    const soon = new Date('2026-12-01T00:00:00Z');
    const later = new Date('2027-01-01T00:00:00Z');
    const pick = (ds: PriceDiscount[]) =>
      planPrice(starter, 'month', ds)!.saving!.promotionId;
    expect(
      pick([
        flat(100, { promotionId: 'a', endsAt: null }),
        flat(100, { promotionId: 'b', endsAt: later }),
        flat(100, { promotionId: 'c', endsAt: soon }),
      ]),
    ).toBe('c');
    expect(
      pick([
        flat(100, { promotionId: 'z', endsAt: soon }),
        flat(100, { promotionId: 'y', endsAt: soon }),
      ]),
    ).toBe('y');
    expect(
      pick([flat(100, { promotionId: 'b' }), flat(100, { promotionId: 'a' })]),
    ).toBe('a');
  });

  it('coupon on top of the discounted price (PR-D16), floor ৳0, saving kept separate', () => {
    const price = planPrice(
      starter,
      'month',
      [flat(500, { promotionId: 'launch' })],
      percent(50, {
        promotionId: 'coupon',
        discountScope: 'TOTAL',
      }),
    )!;
    // 999 − 500 = 499 → 50% → 249 (rounded down).
    expect(price).toMatchObject({
      listChargedBdt: 999,
      chargedBdt: 249,
      perMonthBdt: 249,
      saving: { promotionId: 'launch', amountBdt: 500 },
      coupon: { promotionId: 'coupon', amountBdt: 250, label: '50% off' },
    });
    expect(
      planPrice(starter, 'month', [flat(500)], flat(800, { promotionId: 'c' })),
    ).toMatchObject({ chargedBdt: 0, coupon: { amountBdt: 499 } });
    // Coupon alone, yearly PER_MONTH 2 months.
    expect(
      planPrice(
        starter,
        'year',
        [],
        flat(100, { promotionId: 'c', durationMonths: 2 }),
      ),
    ).toMatchObject({
      chargedBdt: 11_388 - 200,
      saving: null,
      coupon: { amountBdt: 200 },
    });
    // No coupon → no `coupon` key.
    expect(planPrice(starter, 'month', [flat(500)])).not.toHaveProperty(
      'coupon',
    );
  });

  it('labels: plain text, en + bn (PR-D7)', () => {
    expect(planPrice(starter, 'month', [percent(50)])!.saving).toMatchObject({
      label: '50% off',
      labelBn: '৫০% ছাড়',
    });
    expect(
      planPrice(starter, 'month', [flat(1_200, { durationMonths: 1 })])!.saving,
    ).toMatchObject({
      label: '৳1,200 off for 1 month',
      labelBn: 'প্রথম ১ মাস ৳১,২০০ ছাড়',
    });
    expect(
      planPrice(starter, 'month', [flat(200, { durationMonths: 3 })])!.saving,
    ).toMatchObject({ label: '৳200 off for 3 months' });
  });

  it('a discount that saves nothing (৳0 plan) is no saving', () => {
    expect(
      planPrice({ monthlyPriceBdt: 0, yearlyMonthlyPriceBdt: 0 }, 'month', [
        flat(100),
      ]),
    ).toMatchObject({ chargedBdt: 0, saving: null });
  });

  it('yearly without a yearly price → null; monthly does not depend on it', () => {
    const plan = { ...starter, yearlyMonthlyPriceBdt: null };
    expect(planPrice(plan, 'year', [flat(100)])).toBeNull();
    expect(planPrice(plan, 'month')).toMatchObject({ perMonthBdt: 999 });
  });
});
