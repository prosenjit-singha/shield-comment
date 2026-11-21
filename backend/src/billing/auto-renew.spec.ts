import { autoRenewTokenContext } from './auto-renew.js';
import { autoRenewAttempt } from './auto-renew.service.js';
import { autoRenewFailedEmail } from './renewal-reminders.js';

const HOUR = 3_600_000;

describe('auto-renew (M8-T6b, M8-D14)', () => {
  const end = new Date('2026-12-10T08:00:00.000Z');
  const at = (hoursLeft: number) => new Date(end.getTime() - hoursLeft * HOUR);

  it('autoRenewAttempt: none > 24 h before, first try ≤ 24 h, retry ≤ 12 h, none once ended', () => {
    expect(autoRenewAttempt(end, at(48))).toBeNull();
    expect(autoRenewAttempt(end, at(24.01))).toBeNull();
    expect(autoRenewAttempt(end, at(24))).toBe(1);
    expect(autoRenewAttempt(end, at(12.5))).toBe(1);
    expect(autoRenewAttempt(end, at(12))).toBe(2);
    expect(autoRenewAttempt(end, at(0.1))).toBe(2);
    expect(autoRenewAttempt(end, at(0))).toBeNull();
    expect(autoRenewAttempt(end, at(-1))).toBeNull();
  });

  it('token cipher context is per billing account', () => {
    expect(autoRenewTokenContext('acc-1')).toBe(
      'sslcommerz_token:billing:acc-1',
    );
  });

  it('failure email: en then bn, Dhaka date, CTA /billing', () => {
    const mail = autoRenewFailedEmail(
      { termEnd: end, planName: 'Growth' },
      'http://app.localhost:5174/',
    );
    expect(mail.subject).toBe(
      'We could not renew your ShieldComment plan · আপনার ShieldComment প্ল্যান অটো-রিনিউ করা যায়নি',
    );
    expect(mail.text).toContain('Growth plan did not go through');
    expect(mail.text).toContain('10 Dec 2026, 14:00');
    expect(mail.text).toContain('অটো-রিনিউ করা যায়নি');
    expect(mail.text).toContain('নিজে রিনিউ করুন');
    expect(mail.text.indexOf('Renew by hand')).toBeLessThan(
      mail.text.indexOf('নিজে রিনিউ'),
    );
    expect(mail.html).toContain('http://app.localhost:5174/billing');
  });
});
