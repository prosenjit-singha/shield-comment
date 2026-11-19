import {
  dhakaDate,
  dhakaMidnight,
  endedStatus,
  isRealDateOnly,
  MANUAL_ACTIVATION_MAX_DAYS_BACK,
  manualTerm,
  startDateError,
  toActivationAudit,
} from './manual-activation.js';

const iso = (d: Date) => d.toISOString();

describe('manual activation rules (PW-T9)', () => {
  describe('isRealDateOnly', () => {
    it.each(['2026-11-20', '2024-02-29', '2026-01-31', '2026-12-31'])(
      'accepts %s',
      (value) => expect(isRealDateOnly(value)).toBe(true),
    );

    it.each([
      '2026-02-29',
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2026-11-31',
      '2026-1-5',
      '20-11-2026',
      '2026-11-20T00:00:00Z',
      ' 2026-11-20',
      '',
      20261120,
      null,
      undefined,
    ])('rejects %j', (value) => expect(isRealDateOnly(value)).toBe(false));
  });

  it('dhakaMidnight is 00:00 Asia/Dhaka (18:00 UTC the day before)', () => {
    expect(iso(dhakaMidnight('2026-11-20'))).toBe('2026-11-19T18:00:00.000Z');
    expect(iso(dhakaMidnight('2026-01-01'))).toBe('2025-12-31T18:00:00.000Z');
    expect(() => dhakaMidnight('2026-02-30')).toThrow(RangeError);
  });

  it('dhakaDate turns at 18:00 UTC', () => {
    expect(dhakaDate(new Date('2026-11-19T17:59:59.999Z'))).toBe('2026-11-19');
    expect(dhakaDate(new Date('2026-11-19T18:00:00.000Z'))).toBe('2026-11-20');
    expect(dhakaDate(new Date('2026-12-31T18:30:00.000Z'))).toBe('2027-01-01');
  });

  describe('startDateError', () => {
    // 20 Nov 2026, 10:00 in Dhaka.
    const now = new Date('2026-11-20T04:00:00.000Z');

    it('accepts today and up to 31 days back (Dhaka days)', () => {
      expect(MANUAL_ACTIVATION_MAX_DAYS_BACK).toBe(31);
      expect(startDateError('2026-11-20', now)).toBeNull();
      expect(startDateError('2026-11-01', now)).toBeNull();
      expect(startDateError('2026-10-20', now)).toBeNull();
    });

    it('rejects 32 days back, the future and bad dates', () => {
      expect(startDateError('2026-10-19', now)).toMatch(/at most 31 days/);
      expect(startDateError('2026-11-21', now)).toMatch(/future/);
      expect(startDateError('2026-11-31', now)).toMatch(/YYYY-MM-DD/);
    });

    it('uses the Dhaka date of now, not the UTC one', () => {
      // 19 Nov 18:30 UTC = 20 Nov 00:30 Dhaka: "today" is already the 20th.
      const lateUtc = new Date('2026-11-19T18:30:00.000Z');
      expect(startDateError('2026-11-20', lateUtc)).toBeNull();
      expect(startDateError('2026-10-20', lateUtc)).toBeNull();
      expect(startDateError('2026-10-19', lateUtc)).not.toBeNull();
      // 19 Nov 17:59 UTC = 19 Nov 23:59 Dhaka: the 20th is still the future.
      const beforeTurn = new Date('2026-11-19T17:59:00.000Z');
      expect(startDateError('2026-11-20', beforeTurn)).toMatch(/future/);
    });
  });

  describe('manualTerm', () => {
    it('monthly: start 00:00 Dhaka + 1 month', () => {
      const term = manualTerm('2026-11-20', 'month');
      expect(iso(term.start)).toBe('2026-11-19T18:00:00.000Z');
      expect(iso(term.end)).toBe('2026-12-19T18:00:00.000Z');
    });

    it('clamps 31 Jan + 1 month to the end of February (leap and common years)', () => {
      expect(iso(manualTerm('2026-01-31', 'month').end)).toBe(
        '2026-02-27T18:00:00.000Z', // 28 Feb 2026 00:00 Dhaka
      );
      expect(iso(manualTerm('2028-01-31', 'month').end)).toBe(
        '2028-02-28T18:00:00.000Z', // 29 Feb 2028 00:00 Dhaka
      );
      expect(iso(manualTerm('2026-03-31', 'month').end)).toBe(
        '2026-04-29T18:00:00.000Z', // 30 Apr
      );
    });

    it('yearly: + 12 months (29 Feb → 28 Feb)', () => {
      expect(iso(manualTerm('2026-11-20', 'year').end)).toBe(
        '2027-11-19T18:00:00.000Z',
      );
      expect(iso(manualTerm('2028-02-29', 'year').end)).toBe(
        '2029-02-27T18:00:00.000Z',
      );
    });

    it('crosses the year end', () => {
      expect(iso(manualTerm('2026-12-15', 'month').end)).toBe(
        '2027-01-14T18:00:00.000Z',
      );
    });
  });

  it('endedStatus: CANCELED while the term runs, EXPIRED once it is over', () => {
    const now = new Date('2026-11-20T04:00:00.000Z');
    expect(
      endedStatus({ currentTermEnd: new Date('2026-11-21T00:00:00Z') }, now),
    ).toEqual({ status: 'CANCELED', canceledAt: now });
    expect(endedStatus({ currentTermEnd: now }, now)).toEqual({
      status: 'EXPIRED',
    });
  });

  describe('toActivationAudit', () => {
    const base = {
      adminId: 'admin',
      billingAccountId: 'acc',
      workspaceId: 'ws',
      after: {
        id: 'sub-new',
        planId: 'plan-g',
        interval: 'year' as const,
        status: 'ACTIVE' as const,
      },
      reason: 'Paid by bKash',
      price: {
        listChargedBdt: 2499,
        chargedBdt: 2499,
        perMonthBdt: 2499,
        discount: null,
        coupon: null,
      },
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
    };

    it('maps before + after', () => {
      expect(
        toActivationAudit({
          ...base,
          before: {
            id: 'sub-old',
            planId: 'plan-s',
            interval: 'month',
            status: 'TRIALING',
            currentTermEnd: new Date(),
          },
        }),
      ).toEqual({
        adminId: 'admin',
        billingAccountId: 'acc',
        workspaceId: 'ws',
        beforeSubscriptionId: 'sub-old',
        beforePlanId: 'plan-s',
        beforeInterval: 'month',
        beforeStatus: 'TRIALING',
        afterSubscriptionId: 'sub-new',
        afterPlanId: 'plan-g',
        afterInterval: 'year',
        afterStatus: 'ACTIVE',
        reason: 'Paid by bKash',
        price: base.price,
        ipAddress: '203.0.113.9',
        userAgent: 'vitest',
      });
    });

    it('nulls every before column without a live subscription', () => {
      expect(toActivationAudit({ ...base, before: null })).toMatchObject({
        beforeSubscriptionId: null,
        beforePlanId: null,
        beforeInterval: null,
        beforeStatus: null,
        ipAddress: '203.0.113.9',
      });
    });
  });
});
