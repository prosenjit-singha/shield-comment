import { subscriptionPeriod } from './live-subscription.queries.js';
import {
  assertWalletAmount,
  MAX_WALLET_AMOUNT,
  monthlyReset,
  nextReset,
  walletPeriodAt,
} from './wallet-period.js';

/** An instant from a Dhaka wall clock (`YYYY-MM-DDTHH:mm`), Asia/Dhaka = UTC+6. */
const dhaka = (wall: string) => new Date(`${wall}:00.000+06:00`);
const iso = (d: Date) => d.toISOString();

describe('nextReset (Asia/Dhaka billing date, PW-D4)', () => {
  it('keeps the anchor day and time of day', () => {
    const anchor = dhaka('2026-11-19T15:30');
    expect(iso(nextReset(anchor, anchor))).toBe(iso(dhaka('2026-12-19T15:30')));
    expect(iso(nextReset(anchor, dhaka('2027-01-05T00:00')))).toBe(
      iso(dhaka('2027-01-19T15:30')),
    );
  });

  it('an anchor on the 31st clamps to the month end and comes back (Feb 28 → Mar 31)', () => {
    const anchor = dhaka('2027-01-31T10:00');
    expect(iso(nextReset(anchor, anchor))).toBe(iso(dhaka('2027-02-28T10:00')));
    expect(iso(nextReset(anchor, dhaka('2027-02-28T10:00')))).toBe(
      iso(dhaka('2027-03-31T10:00')),
    );
    expect(iso(nextReset(anchor, dhaka('2027-03-31T10:00')))).toBe(
      iso(dhaka('2027-04-30T10:00')),
    );
    expect(iso(nextReset(anchor, dhaka('2027-04-30T10:00')))).toBe(
      iso(dhaka('2027-05-31T10:00')),
    );
  });

  it('February in a leap year: the 29th exists (31st and 30th clamp to it)', () => {
    expect(
      iso(nextReset(dhaka('2028-01-31T10:00'), dhaka('2028-02-01T00:00'))),
    ).toBe(iso(dhaka('2028-02-29T10:00')));
    expect(
      iso(nextReset(dhaka('2028-01-30T10:00'), dhaka('2028-02-01T00:00'))),
    ).toBe(iso(dhaka('2028-02-29T10:00')));
    expect(
      iso(nextReset(dhaka('2028-01-29T10:00'), dhaka('2028-02-01T00:00'))),
    ).toBe(iso(dhaka('2028-02-29T10:00')));
  });

  it('anchors on the 29th / 30th in a non-leap February clamp to the 28th', () => {
    for (const day of ['29', '30']) {
      const anchor = dhaka(`2027-01-${day}T08:00`);
      expect(iso(nextReset(anchor, anchor))).toBe(
        iso(dhaka('2027-02-28T08:00')),
      );
      expect(iso(nextReset(anchor, dhaka('2027-02-28T08:00')))).toBe(
        iso(dhaka(`2027-03-${day}T08:00`)),
      );
    }
  });

  it('a Feb 29 anchor resets on Feb 28 in the next (non-leap) year and the 29th in months that have it', () => {
    const anchor = dhaka('2028-02-29T09:00');
    expect(iso(nextReset(anchor, anchor))).toBe(iso(dhaka('2028-03-29T09:00')));
    expect(iso(monthlyReset(anchor, 12))).toBe(iso(dhaka('2029-02-28T09:00')));
    expect(iso(monthlyReset(anchor, 48))).toBe(iso(dhaka('2032-02-29T09:00')));
  });

  it('an anchor at Dhaka midnight (18:00Z the day before) uses the Dhaka day', () => {
    const anchor = new Date('2026-11-30T18:00:00.000Z'); // 2026-12-01 00:00 Dhaka
    expect(iso(nextReset(anchor, anchor))).toBe('2026-12-31T18:00:00.000Z');
    expect(iso(nextReset(anchor, new Date('2027-01-31T17:59:59.999Z')))).toBe(
      '2027-01-31T18:00:00.000Z',
    );
  });

  it('after exactly on a reset → the next one; 1 ms before → that reset', () => {
    const anchor = dhaka('2026-11-19T15:30');
    const dec = dhaka('2026-12-19T15:30');
    expect(iso(nextReset(anchor, new Date(dec.getTime() - 1)))).toBe(iso(dec));
    expect(iso(nextReset(anchor, dec))).toBe(iso(dhaka('2027-01-19T15:30')));
  });

  it('rolls the year over and handles `after` before the anchor', () => {
    const anchor = dhaka('2026-12-15T12:00');
    expect(iso(nextReset(anchor, dhaka('2026-12-20T00:00')))).toBe(
      iso(dhaka('2027-01-15T12:00')),
    );
    expect(iso(nextReset(anchor, dhaka('2026-10-01T00:00')))).toBe(
      iso(dhaka('2026-10-15T12:00')),
    );
  });

  it('is a fixed UTC+6 offset all year (no DST): same UTC hour in January and July', () => {
    const anchor = new Date('2026-01-10T04:00:00.000Z');
    expect(iso(monthlyReset(anchor, 6))).toBe('2026-07-10T04:00:00.000Z');
    expect(iso(monthlyReset(anchor, 2))).toBe('2026-03-10T04:00:00.000Z');
  });

  it('rejects invalid dates', () => {
    expect(() => nextReset(new Date('nope'), new Date())).toThrow(RangeError);
    expect(() => nextReset(new Date(), new Date('nope'))).toThrow(RangeError);
    expect(() => monthlyReset(new Date(), 1.5)).toThrow(RangeError);
  });
});

describe('walletPeriodAt (period containing now, cut at the term end)', () => {
  const anchor = dhaka('2027-01-31T10:00');
  const yearEnd = dhaka('2028-01-31T10:00');

  it('first period starts at the anchor', () => {
    expect(walletPeriodAt(anchor, dhaka('2027-02-10T00:00'), yearEnd)).toEqual({
      anchor,
      start: anchor,
      end: dhaka('2027-02-28T10:00'),
    });
  });

  it('later periods start on the clamped reset (yearly terms reset monthly)', () => {
    const period = walletPeriodAt(anchor, dhaka('2027-03-05T00:00'), yearEnd);
    expect(iso(period.start)).toBe(iso(dhaka('2027-02-28T10:00')));
    expect(iso(period.end)).toBe(iso(dhaka('2027-03-31T10:00')));
    const exact = walletPeriodAt(anchor, dhaka('2027-03-31T10:00'), yearEnd);
    expect(iso(exact.start)).toBe(iso(dhaka('2027-03-31T10:00')));
  });

  it('end = min(nextReset, term end)', () => {
    const termEnd = dhaka('2027-02-20T00:00');
    expect(
      iso(walletPeriodAt(anchor, dhaka('2027-02-10T00:00'), termEnd).end),
    ).toBe(iso(termEnd));
    expect(
      iso(walletPeriodAt(anchor, dhaka('2028-01-20T00:00'), yearEnd).end),
    ).toBe(iso(yearEnd));
  });

  it('now before the anchor → the first period; now at / after the term end → RangeError', () => {
    expect(
      iso(walletPeriodAt(anchor, dhaka('2027-01-01T00:00'), yearEnd).start),
    ).toBe(iso(anchor));
    expect(() => walletPeriodAt(anchor, yearEnd, yearEnd)).toThrow(RangeError);
  });
});

describe('subscriptionPeriod', () => {
  const start = dhaka('2026-11-19T15:30');
  const trialEnd = dhaka('2026-11-26T15:30');

  it('a trial is one period [started_at, trial end) whatever its length', () => {
    const longEnd = dhaka('2027-02-17T15:30');
    expect(
      subscriptionPeriod(
        {
          status: 'TRIALING',
          startedAt: start,
          currentTermStart: start,
          currentTermEnd: longEnd,
        },
        dhaka('2027-01-25T00:00'),
      ),
    ).toEqual({ anchor: start, start, end: longEnd });
    expect(
      subscriptionPeriod(
        {
          status: 'TRIALING',
          startedAt: start,
          currentTermStart: start,
          currentTermEnd: trialEnd,
        },
        dhaka('2026-11-20T00:00'),
      ).end,
    ).toEqual(trialEnd);
  });

  it('a paid term is anchored at current_term_start', () => {
    const termStart = dhaka('2026-12-05T09:00');
    const period = subscriptionPeriod(
      {
        status: 'ACTIVE',
        startedAt: start,
        currentTermStart: termStart,
        currentTermEnd: dhaka('2027-12-05T09:00'),
      },
      dhaka('2027-02-10T00:00'),
    );
    expect(period.anchor).toEqual(termStart);
    expect(iso(period.start)).toBe(iso(dhaka('2027-02-05T09:00')));
    expect(iso(period.end)).toBe(iso(dhaka('2027-03-05T09:00')));
  });
});

describe('assertWalletAmount', () => {
  it.each([1, 2, MAX_WALLET_AMOUNT])('accepts %j', (n) => {
    expect(() => assertWalletAmount(n)).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, MAX_WALLET_AMOUNT + 1])(
    'rejects %j',
    (n) => {
      expect(() => assertWalletAmount(n)).toThrow(RangeError);
    },
  );
});
