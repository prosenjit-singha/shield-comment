import { trialEndsAt } from './trial.js';

/** An instant from a Dhaka wall clock (`YYYY-MM-DDTHH:mm`), Asia/Dhaka = UTC+6. */
const dhaka = (wall: string) => new Date(`${wall}:00.000+06:00`);

describe('trialEndsAt (PW-D8)', () => {
  it('adds whole days at the same Dhaka wall-clock time', () => {
    expect(trialEndsAt(dhaka('2026-11-19T15:30'), 7)).toEqual(
      dhaka('2026-11-26T15:30'),
    );
    expect(trialEndsAt(dhaka('2026-11-19T15:30'), 3)).toEqual(
      dhaka('2026-11-22T15:30'),
    );
  });

  it('crosses month and year ends, Feb in a leap year', () => {
    expect(trialEndsAt(dhaka('2026-12-28T23:59'), 7)).toEqual(
      dhaka('2027-01-04T23:59'),
    );
    expect(trialEndsAt(dhaka('2028-02-25T00:00'), 14)).toEqual(
      dhaka('2028-03-10T00:00'),
    );
    expect(trialEndsAt(dhaka('2027-02-01T10:00'), 30)).toEqual(
      dhaka('2027-03-03T10:00'),
    );
  });

  it('keeps milliseconds (the stored end equals start + n × 24 h exactly)', () => {
    const start = new Date('2026-11-19T09:30:00.123Z');
    expect(trialEndsAt(start, 90).getTime() - start.getTime()).toBe(
      90 * 86_400_000,
    );
  });

  it.each([0, 91, 1.5, -7, Number.NaN])(
    'rejects %s days (outside plans_trial_days_check)',
    (days) => {
      expect(() => trialEndsAt(new Date(), days)).toThrow(RangeError);
    },
  );

  it('rejects an invalid start', () => {
    expect(() => trialEndsAt(new Date('nope'), 7)).toThrow(RangeError);
  });
});
