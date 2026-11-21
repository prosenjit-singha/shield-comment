import { EmailSendError } from '../email/email.service.js';
import {
  createAccountMailer,
  passwordResetEmail,
  RESET_PASSWORD_EXPIRES_IN_SEC,
  verificationEmail,
  VERIFY_EMAIL_EXPIRES_IN_SEC,
} from './account-emails.js';

const APP = 'http://app.localhost:5174';
/** URL-unsafe on purpose: the link must encode it. */
const TOKEN = 'tok+en/with=chars';
const ENCODED = encodeURIComponent(TOKEN);

describe('account emails (M9-T5)', () => {
  it('links live 1 hour', () => {
    expect(RESET_PASSWORD_EXPIRES_IN_SEC).toBe(3600);
    expect(VERIFY_EMAIL_EXPIRES_IN_SEC).toBe(3600);
  });

  describe('passwordResetEmail', () => {
    const content = passwordResetEmail(TOKEN, `${APP}/`);

    it('English then Bangla subject', () => {
      expect(content.subject).toBe(
        'Reset your ShieldComment BD password · আপনার ShieldComment BD পাসওয়ার্ড রিসেট করুন',
      );
    });

    it('en + bn body, CTA <CLIENT_APP_URL>/reset-password?token= in both', () => {
      const url = `${APP}/reset-password?token=${ENCODED}`;
      expect(content.text).toContain(`Reset password: ${url}`);
      expect(content.text).toContain(`পাসওয়ার্ড রিসেট করুন: ${url}`);
      expect(content.text).toContain('expires in 1 hour');
      expect(content.text).toContain('signed out on every device');
      expect(content.text).toContain('১ ঘণ্টা');
      expect(content.text.indexOf('Reset password:')).toBeLessThan(
        content.text.indexOf('পাসওয়ার্ড রিসেট করুন:'),
      );
      expect(content.html).toContain(`href="${url}"`);
      expect(content.html).toContain('lang="bn"');
    });
  });

  describe('verificationEmail', () => {
    const content = verificationEmail(TOKEN, APP);

    it('English then Bangla subject', () => {
      expect(content.subject).toBe(
        'Confirm your email for ShieldComment BD · ShieldComment BD-এর জন্য আপনার ইমেইল নিশ্চিত করুন',
      );
    });

    it('en + bn body, CTA <CLIENT_APP_URL>/verify-email?token= in both', () => {
      const url = `${APP}/verify-email?token=${ENCODED}`;
      expect(content.text).toContain(`Confirm email: ${url}`);
      expect(content.text).toContain(`ইমেইল নিশ্চিত করুন: ${url}`);
      expect(content.text).toContain('স্বাগতম');
      expect(content.html).toContain(`href="${url}"`);
    });
  });

  describe('createAccountMailer', () => {
    const data = {
      user: { id: 'user-1', email: 'owner@example.com' },
      token: TOKEN,
    };
    const logger = () => ({ warn: vi.fn() });

    it('sends one email to the user per call, with the client links', async () => {
      const send = vi.fn().mockResolvedValue({ delivered: true, id: 'e1' });
      const log = logger();
      const mailer = createAccountMailer({ send }, APP, log as never);
      await mailer.sendResetPassword(data);
      await mailer.sendVerificationEmail(data);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]![0]).toMatchObject({
        to: 'owner@example.com',
        subject: passwordResetEmail(TOKEN, APP).subject,
      });
      expect(send.mock.calls[0]![0].text).toContain('/reset-password?token=');
      expect(send.mock.calls[1]![0].text).toContain('/verify-email?token=');
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('a failed send never throws and logs neither the token nor the address', async () => {
      const send = vi
        .fn()
        .mockRejectedValue(
          new EmailSendError(`Resend 503 ${TOKEN}`, 503, true),
        );
      const log = logger();
      const mailer = createAccountMailer({ send }, APP, log as never);
      await expect(mailer.sendResetPassword(data)).resolves.toBeUndefined();
      await expect(mailer.sendVerificationEmail(data)).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn.mock.calls[0]![0]).toEqual({
        userId: 'user-1',
        kind: 'password-reset',
      });
      expect(log.warn.mock.calls[1]![0]).toEqual({
        userId: 'user-1',
        kind: 'verify-email',
      });
      const logged = JSON.stringify(log.warn.mock.calls);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(ENCODED);
      expect(logged).not.toContain('owner@example.com');
    });
  });
});
