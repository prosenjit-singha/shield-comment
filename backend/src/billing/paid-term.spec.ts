import type { PaymentPrice } from '../db/schema/index.js';
import { planPrice, type PriceDiscount } from '../plans/plan-price.js';
import {
  type CurrentTerm,
  extendedEnd,
  paidTerm,
  paymentAmount,
  paymentKind,
  promotionMonths,
  toPaymentPrice,
  upgradeCredit,
} from './paid-term.js';

const d = (iso: string) => new Date(iso);
const iso = (date: Date) => date.toISOString();
/** An instant given as Asia/Dhaka wall time (UTC+6). */
const dhaka = (wall: string) => new Date(`${wall}+06:00`);

const active = (overrides: Partial<CurrentTerm> = {}): CurrentTerm => ({
  status: 'ACTIVE',
  planId: 'growth',
  interval: 'month',
  currentTermStart: dhaka('2026-11-01T10:00:00'),
  currentTermEnd: dhaka('2026-12-01T10:00:00'),
  ...overrides,
});
const target = { planId: 'growth', interval: 'month' as const };

describe('paid-term rules (M8-T3)', () => {
  describe('paidTerm', () => {
    const now = dhaka('2026-11-25T12:00:00');

    it('NEW: a monthly term from the payment, time of day kept', () => {
      expect(paidTerm('NEW', null, target, now, now)).toEqual({
        extend: false,
        start: now,
        end: dhaka('2026-12-25T12:00:00'),
      });
    });

    it('month-end clamp on the Dhaka calendar (31 Jan → 28 Feb)', () => {
      const start = dhaka('2026-01-31T09:00:00');
      expect(iso(paidTerm('NEW', null, target, start, start).end)).toBe(
        iso(dhaka('2026-02-28T09:00:00')),
      );
    });

    it('Dhaka midnight: 00:30 Dhaka on 31 Jan is still 30 Jan in UTC', () => {
      const start = d('2026-01-30T18:30:00.000Z'); // 31 Jan 00:30 Dhaka
      expect(iso(paidTerm('NEW', null, target, start, start).end)).toBe(
        '2026-02-27T18:30:00.000Z', // 28 Feb 00:30 Dhaka (UTC math would give 1 Mar Dhaka)
      );
    });

    it('yearly: 12 months, 29 Feb clamps to 28 Feb', () => {
      const start = dhaka('2028-02-29T08:00:00');
      expect(
        iso(
          paidTerm('NEW', null, { ...target, interval: 'year' }, start, start)
            .end,
        ),
      ).toBe(iso(dhaka('2029-02-28T08:00:00')));
    });

    it('trial → paid (D6): a new term from the payment, the trial is not extended', () => {
      const trial = active({
        status: 'TRIALING',
        currentTermEnd: dhaka('2026-11-28T10:00:00'),
      });
      expect(paidTerm('NEW', trial, target, now, now)).toEqual({
        extend: false,
        start: now,
        end: dhaka('2026-12-25T12:00:00'),
      });
    });

    it('RENEWAL of the live term extends from its end (D4: early payment loses nothing)', () => {
      expect(paidTerm('RENEWAL', active(), target, now, now)).toEqual({
        extend: true,
        start: dhaka('2026-12-01T10:00:00'),
        end: dhaka('2027-01-01T10:00:00'),
      });
    });

    it('RENEWAL keeps the anchor day: 31 Jan → 28 Feb → 31 Mar', () => {
      const row = active({
        currentTermStart: dhaka('2026-01-31T10:00:00'),
        currentTermEnd: dhaka('2026-02-28T10:00:00'),
      });
      expect(
        iso(
          paidTerm(
            'RENEWAL',
            row,
            target,
            dhaka('2026-02-25T00:00:00'),
            dhaka('2026-02-25T00:00:00'),
          ).end,
        ),
      ).toBe(iso(dhaka('2026-03-31T10:00:00')));
    });

    it('RENEWAL of a yearly term adds 12 months to its end', () => {
      const row = active({
        interval: 'year',
        currentTermStart: dhaka('2026-01-15T00:00:00'),
        currentTermEnd: dhaka('2027-01-15T00:00:00'),
      });
      const at = dhaka('2027-01-10T00:00:00');
      expect(
        paidTerm('RENEWAL', row, { ...target, interval: 'year' }, at, at),
      ).toMatchObject({ extend: true, end: dhaka('2028-01-15T00:00:00') });
    });

    it('RENEWAL after the term ended: a new term from the payment', () => {
      const late = dhaka('2026-12-03T09:00:00');
      expect(paidTerm('RENEWAL', active(), target, late, late)).toEqual({
        extend: false,
        start: late,
        end: dhaka('2027-01-03T09:00:00'),
      });
    });

    it('RENEWAL on another plan or interval while the term runs: scheduled from its end (M8-D7b)', () => {
      expect(
        paidTerm(
          'RENEWAL',
          active(),
          { ...target, planId: 'starter' },
          now,
          now,
        ),
      ).toEqual({
        extend: false,
        scheduled: true,
        start: dhaka('2026-12-01T10:00:00'),
        end: dhaka('2027-01-01T10:00:00'),
      });
      expect(
        paidTerm('RENEWAL', active({ interval: 'year' }), target, now, now),
      ).toMatchObject({ scheduled: true, end: dhaka('2027-01-01T10:00:00') });
    });

    it('UPGRADE (D7): a new term from today', () => {
      expect(
        paidTerm('UPGRADE', active(), { ...target, planId: 'pro' }, now, now),
      ).toEqual({
        extend: false,
        start: now,
        end: dhaka('2026-12-25T12:00:00'),
      });
    });
  });

  it('extendedEnd: an end off the anchor day just adds the months', () => {
    expect(
      iso(
        extendedEnd(
          {
            currentTermStart: dhaka('2026-11-01T10:00:00'),
            currentTermEnd: dhaka('2026-11-20T10:00:00'),
          },
          1,
        ),
      ),
    ).toBe(iso(dhaka('2026-12-20T10:00:00')));
  });

  describe('upgradeCredit (D7)', () => {
    const paid = (overrides: Partial<CurrentTerm> = {}) => ({
      ...active(overrides),
      chargedBdt: 1000,
    });

    it('unused whole days × charged ÷ term days, rounded down', () => {
      // 30-day term; 14.9 days left → 14 → 1000 × 14 / 30 = 466.67 → 466.
      expect(upgradeCredit(paid(), 5000, dhaka('2026-11-16T12:00:00'))).toBe(
        466,
      );
    });

    it('never more than the new price (amount floors at ৳0)', () => {
      expect(upgradeCredit(paid(), 300, dhaka('2026-11-02T10:00:00'))).toBe(
        300,
      );
    });

    it('a partly used last day counts as used', () => {
      expect(upgradeCredit(paid(), 5000, dhaka('2026-11-30T10:00:01'))).toBe(0);
    });

    it('yearly: by the days of the year', () => {
      const row = {
        ...active({
          interval: 'year',
          currentTermStart: dhaka('2026-01-01T00:00:00'),
          currentTermEnd: dhaka('2027-01-01T00:00:00'),
        }),
        chargedBdt: 36_500,
      };
      // 100 days left of 365 → 10,000.
      expect(upgradeCredit(row, 99_999, dhaka('2026-09-23T00:00:00'))).toBe(
        10_000,
      );
    });

    it('an early-renewed row: the term days are those of its last term', () => {
      const row = paid({
        currentTermStart: dhaka('2026-10-01T10:00:00'),
        currentTermEnd: dhaka('2026-12-01T10:00:00'),
      });
      // Last term 1 Nov → 1 Dec = 30 days; 35 days left → 1,166, capped by the new price.
      expect(upgradeCredit(row, 5000, dhaka('2026-10-27T10:00:00'))).toBe(1166);
    });

    it('0 for a trial, an ended term or a row without a price', () => {
      const at = dhaka('2026-11-16T12:00:00');
      expect(upgradeCredit(paid({ status: 'TRIALING' }), 5000, at)).toBe(0);
      expect(upgradeCredit(paid(), 5000, dhaka('2026-12-01T10:00:00'))).toBe(0);
      expect(upgradeCredit({ ...active(), chargedBdt: null }, 5000, at)).toBe(
        0,
      );
    });
  });

  describe('paymentKind (D4, D6, D7)', () => {
    const now = dhaka('2026-11-20T12:00:00');
    const growth = { ...target, monthlyPriceBdt: 2499 };
    const cur = (
      overrides: Partial<CurrentTerm> = {},
      hasScheduledChange = false,
    ) => ({
      ...active(overrides),
      monthlyPriceBdt: 2499,
      hasScheduledChange,
    });

    it('no live term → NEW, or RENEWAL after a paid term', () => {
      expect(paymentKind(null, growth, false, now)).toEqual({ kind: 'NEW' });
      expect(paymentKind(null, growth, true, now)).toEqual({ kind: 'RENEWAL' });
      expect(
        paymentKind(cur(), growth, true, dhaka('2026-12-02T00:00:00')),
      ).toEqual({ kind: 'RENEWAL' });
    });

    it('a live trial → NEW (D6)', () => {
      expect(
        paymentKind(cur({ status: 'TRIALING' }), growth, false, now),
      ).toEqual({ kind: 'NEW' });
    });

    it('same plan + interval: RENEWAL only from 7 days before the end', () => {
      expect(paymentKind(cur(), growth, true, now)).toEqual({
        error: 'RENEWAL_NOT_OPEN',
      });
      expect(
        paymentKind(cur(), growth, true, dhaka('2026-11-24T10:00:00')),
      ).toEqual({ kind: 'RENEWAL' });
    });

    it('higher plan or month → year → UPGRADE', () => {
      expect(
        paymentKind(
          cur(),
          { planId: 'pro', interval: 'month', monthlyPriceBdt: 5999 },
          true,
          now,
        ),
      ).toEqual({ kind: 'UPGRADE' });
      expect(
        paymentKind(cur(), { ...growth, interval: 'year' }, true, now),
      ).toEqual({ kind: 'UPGRADE' });
    });

    it('downgrade or year → month in the 7-day window → RENEWAL (scheduled, M8-D7b)', () => {
      const inWindow = dhaka('2026-11-24T10:00:00');
      const starter = { planId: 'starter', interval: 'month' as const };
      expect(
        paymentKind(
          cur(),
          { ...starter, monthlyPriceBdt: 999 },
          true,
          inWindow,
        ),
      ).toEqual({ kind: 'RENEWAL' });
      expect(
        paymentKind(cur({ interval: 'year' }), growth, true, inWindow),
      ).toEqual({ kind: 'RENEWAL' });
    });

    it('a scheduled change → PLAN_CHANGE_SCHEDULED for any plan, even an upgrade', () => {
      const scheduled = { error: 'PLAN_CHANGE_SCHEDULED' };
      const inWindow = dhaka('2026-11-24T10:00:00');
      expect(paymentKind(cur({}, true), growth, true, inWindow)).toEqual(
        scheduled,
      );
      expect(
        paymentKind(
          cur({}, true),
          { planId: 'pro', interval: 'month', monthlyPriceBdt: 5999 },
          true,
          now,
        ),
      ).toEqual(scheduled);
      expect(
        paymentKind(cur({ status: 'TRIALING' }, true), growth, false, now),
      ).toEqual({ kind: 'NEW' });
    });

    it('downgrade or year → month before the window → PLAN_CHANGE_AT_RENEWAL', () => {
      const change = { error: 'PLAN_CHANGE_AT_RENEWAL' };
      expect(
        paymentKind(
          cur(),
          { planId: 'starter', interval: 'month', monthlyPriceBdt: 999 },
          true,
          now,
        ),
      ).toEqual(change);
      expect(paymentKind(cur({ interval: 'year' }), growth, true, now)).toEqual(
        change,
      );
      expect(
        paymentKind(
          cur({ interval: 'year' }),
          { planId: 'pro', interval: 'month', monthlyPriceBdt: 5999 },
          true,
          now,
        ),
      ).toEqual(change);
    });
  });

  describe('price snapshot', () => {
    const coupon: PriceDiscount = {
      promotionId: 'c1',
      discountType: 'FLAT',
      discountValue: 100,
      discountScope: 'PER_MONTH',
      durationMonths: 3,
      endsAt: null,
    };
    const names = new Map([['c1', { name: 'Welcome', code: 'HELLO' }]]);
    const plan = { monthlyPriceBdt: 1000, yearlyMonthlyPriceBdt: 900 };

    it('a claimed 3-month coupon on its 2nd renewal: "3 of 3", then it advances 1 month', () => {
      // Claimed with 1 month left (accountCoupon prices only the months left).
      const left = { ...coupon, durationMonths: 1 };
      const price = toPaymentPrice(
        planPrice(plan, 'month', [], left)!,
        'month',
        {
          discount: null,
          coupon: { terms: coupon, monthsUsed: 2, redemptionId: 'r1' },
        },
        names,
      );
      expect(price).toEqual({
        listChargedBdt: 1000,
        chargedBdt: 900,
        perMonthBdt: 900,
        discount: null,
        coupon: {
          promotionId: 'c1',
          redemptionId: 'r1',
          name: 'Welcome',
          code: 'HELLO',
          label: '৳100 off for 1 month',
          labelBn: 'প্রথম ১ মাস ৳১০০ ছাড়',
          amountBdt: 100,
          months: { from: 3, to: 3, of: 3 },
        },
        creditBdt: 0,
      });
      expect(promotionMonths(price.coupon!, 'month')).toBe(1);
    });

    it('a yearly term with a new 3-month coupon uses 3 months', () => {
      const price = toPaymentPrice(
        planPrice(plan, 'year', [], coupon)!,
        'year',
        {
          discount: null,
          coupon: { terms: coupon, monthsUsed: 0, redemptionId: null },
        },
        names,
      );
      expect(price.coupon).toMatchObject({
        redemptionId: null,
        amountBdt: 300,
        months: { from: 1, to: 3, of: 3 },
      });
      expect(promotionMonths(price.coupon!, 'year')).toBe(3);
      // Forever / TOTAL: the whole term.
      expect(promotionMonths({ months: null }, 'year')).toBe(12);
    });

    it('paymentAmount = charged − credit, floor ৳0', () => {
      const price = (chargedBdt: number, creditBdt: number) =>
        ({ chargedBdt, creditBdt }) as PaymentPrice;
      expect(paymentAmount(price(2499, 466))).toBe(2033);
      expect(paymentAmount(price(300, 500))).toBe(0);
    });
  });
});
