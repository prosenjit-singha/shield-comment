import { scheduledTermEnd } from '../wallet/live-subscription.queries.js';
import { renewalOf } from './billing-summary.js';
import {
  dhakaDaysUntil,
  dueReminder,
  reminderSent,
  renewalReminderEmail,
} from './renewal-reminders.js';

/** An instant given as Asia/Dhaka wall time (UTC+6). */
const dhaka = (wall: string) => new Date(`${wall}+06:00`);
const CLIENT = 'http://app.localhost:5174';

describe('renewal reminders (M8-T6, D4)', () => {
  describe('dueReminder', () => {
    // A manual-activation style end: 00:00 Dhaka on 10 Dec = the plan runs through 9 Dec.
    const end = dhaka('2026-12-10T00:00:00');

    it('Dhaka calendar days, not 24 h blocks', () => {
      expect(dhakaDaysUntil(end, dhaka('2026-12-09T23:59:59'))).toBe(1);
      expect(dhakaDaysUntil(end, dhaka('2026-12-03T00:00:00'))).toBe(7);
      expect(dhakaDaysUntil(end, dhaka('2026-12-02T23:59:59'))).toBe(8);
      // 18:30 UTC on 2 Dec is already 00:30 on 3 Dec in Dhaka.
      expect(dhakaDaysUntil(end, new Date('2026-12-02T18:30:00Z'))).toBe(7);
    });

    it('7 / 3 / 1 days before, 0 on expiry, null before the window', () => {
      expect(dueReminder(end, dhaka('2026-12-02T23:59:59'))).toBeNull();
      expect(dueReminder(end, dhaka('2026-12-03T00:00:00'))).toBe(7);
      expect(dueReminder(end, dhaka('2026-12-06T10:00:00'))).toBe(7); // 4 days
      expect(dueReminder(end, dhaka('2026-12-07T10:00:00'))).toBe(3);
      expect(dueReminder(end, dhaka('2026-12-08T10:00:00'))).toBe(3); // 2 days
      expect(dueReminder(end, dhaka('2026-12-09T10:00:00'))).toBe(1);
      expect(dueReminder(end, dhaka('2026-12-09T23:59:59'))).toBe(1);
      expect(dueReminder(end, dhaka('2026-12-10T00:00:00'))).toBe(0);
      expect(dueReminder(end, dhaka('2026-12-12T10:00:00'))).toBe(0);
    });

    it('an end later in the day: that day is still the 1-day stage', () => {
      const afternoon = dhaka('2026-12-10T14:00:00');
      expect(dueReminder(afternoon, dhaka('2026-12-10T10:00:00'))).toBe(1);
      expect(dueReminder(afternoon, dhaka('2026-12-10T14:00:00'))).toBe(0);
    });

    it('month end: a 31 Jan end is 7 days after 24 Jan; a 1 Mar end counts February', () => {
      expect(
        dueReminder(dhaka('2027-01-31T09:00:00'), dhaka('2027-01-24T10:00:00')),
      ).toBe(7);
      expect(
        dueReminder(dhaka('2027-03-01T09:00:00'), dhaka('2027-02-26T10:00:00')),
      ).toBe(3);
    });
  });

  it('reminderSent: once per stage per term end; a later stage covers an earlier one; a new end starts over', () => {
    const end = dhaka('2026-12-10T00:00:00');
    const none = { termEnd: null, days: null };
    expect(reminderSent(none, end, 7)).toBe(false);
    expect(reminderSent({ termEnd: end, days: 7 }, end, 7)).toBe(true);
    expect(reminderSent({ termEnd: end, days: 7 }, end, 3)).toBe(false);
    expect(reminderSent({ termEnd: end, days: 1 }, end, 3)).toBe(true);
    expect(reminderSent({ termEnd: end, days: 1 }, end, 0)).toBe(false);
    expect(
      reminderSent({ termEnd: end, days: 0 }, dhaka('2027-01-10T00:00:00'), 7),
    ).toBe(false);
  });

  describe('renewalReminderEmail', () => {
    const end = dhaka('2026-12-10T00:00:00');

    it('before the end: en + bn subject with the days, Dhaka date, Renew CTA to /billing', () => {
      const mail = renewalReminderEmail(
        { days: 3, termEnd: end, planName: 'Growth <Pro>' },
        `${CLIENT}/`,
      );
      expect(mail.subject).toBe(
        'Your ShieldComment plan ends in 3 days · আপনার ShieldComment প্ল্যান ৩ দিনের মধ্যে শেষ হবে',
      );
      expect(mail.text).toContain(
        'Your Growth <Pro> plan ends on 10 Dec 2026, 00:00 (Bangladesh time).',
      );
      expect(mail.text).toContain(`Renew plan: ${CLIENT}/billing`);
      expect(mail.text).toContain(`প্ল্যান রিনিউ করুন: ${CLIENT}/billing`);
      expect(mail.html).toContain('Growth &lt;Pro&gt;');
      expect(mail.html).not.toContain('<Pro>');
      expect(
        renewalReminderEmail({ days: 1, termEnd: end, planName: 'G' }, CLIENT)
          .subject,
      ).toMatch(/^Your ShieldComment plan ends in 1 day · /);
    });

    it('on expiry: paused, nothing deleted, Choose a plan', () => {
      const mail = renewalReminderEmail(
        { days: 0, termEnd: end, planName: 'Growth' },
        CLIENT,
      );
      expect(mail.subject).toBe(
        'Your ShieldComment plan has ended · আপনার ShieldComment প্ল্যান শেষ হয়েছে',
      );
      expect(mail.text).toContain('Comment moderation is paused');
      expect(mail.text).toContain('কিছুই মুছে ফেলা হয়নি');
      expect(mail.text).toContain(`Choose a plan: ${CLIENT}/billing`);
    });
  });

  it('scheduledTermEnd (M8-D7b switch): one month / year later, month-end clamped, Dhaka time kept', () => {
    expect(scheduledTermEnd(dhaka('2027-01-31T00:00:00'), 'month')).toEqual(
      dhaka('2027-02-28T00:00:00'),
    );
    expect(scheduledTermEnd(dhaka('2028-02-29T15:30:00'), 'year')).toEqual(
      dhaka('2029-02-28T15:30:00'),
    );
    expect(scheduledTermEnd(dhaka('2026-12-10T00:00:00'), 'month')).toEqual(
      dhaka('2027-01-10T00:00:00'),
    );
  });

  it('renewalOf: ACTIVE only; canRenew from 7 days before the end, never with a scheduled change', () => {
    const end = dhaka('2026-12-10T00:00:00');
    const live = { status: 'ACTIVE' as const, currentTermEnd: end };
    expect(renewalOf(null, false, end)).toBeNull();
    expect(
      renewalOf({ status: 'TRIALING', currentTermEnd: end }, false, end),
    ).toBeNull();
    expect(renewalOf(live, false, dhaka('2026-12-02T23:59:59'))).toEqual({
      dueAt: end,
      canRenew: false,
    });
    expect(renewalOf(live, false, dhaka('2026-12-03T00:00:00'))).toEqual({
      dueAt: end,
      canRenew: true,
    });
    expect(renewalOf(live, true, dhaka('2026-12-09T00:00:00'))).toEqual({
      dueAt: end,
      canRenew: false,
    });
  });
});
