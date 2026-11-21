import { Logger } from '@nestjs/common';
import { bilingualEmail, type EmailContent } from '../email/bilingual-email.js';
import type { EmailService } from '../email/email.service.js';

/** Reset links (D10) and verification links both live 1 hour. */
export const RESET_PASSWORD_EXPIRES_IN_SEC = 3600;
export const VERIFY_EMAIL_EXPIRES_IN_SEC = 3600;

/** `<CLIENT_APP_URL><path>?token=<token>`: the client page posts the token back to `/api/auth/*`. */
function tokenLink(clientAppUrl: string, path: string, token: string): string {
  return `${clientAppUrl.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}`;
}

/** D10: forgot-password email, CTA `<CLIENT_APP_URL>/reset-password?token=`. */
export function passwordResetEmail(
  token: string,
  clientAppUrl: string,
): EmailContent {
  const url = tokenLink(clientAppUrl, '/reset-password', token);
  return bilingualEmail(
    {
      en: {
        subject: 'Reset your ShieldComment BD password',
        lines: [
          'We got a request to reset the password of your ShieldComment BD account.',
          'The link works once and expires in 1 hour. After the reset you are signed out on every device.',
          'If you didn’t ask for this, ignore this email: your password stays the same.',
        ],
        cta: { label: 'Reset password', url },
      },
      bn: {
        subject: 'আপনার ShieldComment BD পাসওয়ার্ড রিসেট করুন',
        lines: [
          'আপনার ShieldComment BD অ্যাকাউন্টের পাসওয়ার্ড রিসেট করার একটি অনুরোধ পেয়েছি।',
          'লিংকটি একবারই কাজ করবে এবং ১ ঘণ্টা পর মেয়াদ শেষ হবে। রিসেটের পর সব ডিভাইস থেকে আপনি সাইন আউট হয়ে যাবেন।',
          'আপনি এই অনুরোধ না করে থাকলে ইমেইলটি উপেক্ষা করুন: আপনার পাসওয়ার্ড বদলাবে না।',
        ],
        cta: { label: 'পাসওয়ার্ড রিসেট করুন', url },
      },
    },
    clientAppUrl,
  );
}

/** D10 (b): sign-up / resend email, CTA `<CLIENT_APP_URL>/verify-email?token=`. */
export function verificationEmail(
  token: string,
  clientAppUrl: string,
): EmailContent {
  const url = tokenLink(clientAppUrl, '/verify-email', token);
  return bilingualEmail(
    {
      en: {
        subject: 'Confirm your email for ShieldComment BD',
        lines: [
          'Welcome to ShieldComment BD! Confirm this email address to finish setting up your account.',
          'The link expires in 1 hour. You can ask for a new one on the sign-in page.',
          'If you didn’t create an account, ignore this email.',
        ],
        cta: { label: 'Confirm email', url },
      },
      bn: {
        subject: 'ShieldComment BD-এর জন্য আপনার ইমেইল নিশ্চিত করুন',
        lines: [
          'ShieldComment BD-তে স্বাগতম! অ্যাকাউন্ট সেটআপ শেষ করতে এই ইমেইল ঠিকানাটি নিশ্চিত করুন।',
          'লিংকটির মেয়াদ ১ ঘণ্টা। সাইন-ইন পেজ থেকে নতুন লিংক চাইতে পারবেন।',
          'আপনি অ্যাকাউন্ট না খুলে থাকলে ইমেইলটি উপেক্ষা করুন।',
        ],
        cta: { label: 'ইমেইল নিশ্চিত করুন', url },
      },
    },
    clientAppUrl,
  );
}

/** What Better Auth hands `sendResetPassword` / `sendVerificationEmail` (we ignore its backend `url`). */
export interface AccountMail {
  user: { id: string; email: string };
  token: string;
}

/**
 * Better Auth's `emailAndPassword.sendResetPassword` + `emailVerification.sendVerificationEmail`.
 * A failed send is warn-logged by user id (never the token or address) and swallowed: the
 * endpoints answer the same generic 200 either way, and the user can ask again.
 */
export function createAccountMailer(
  email: Pick<EmailService, 'send'>,
  clientAppUrl: string,
  logger = new Logger('AccountEmails'),
) {
  const send = async (
    kind: 'password-reset' | 'verify-email',
    data: AccountMail,
    content: EmailContent,
  ): Promise<void> => {
    try {
      await email.send({ to: data.user.email, ...content });
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'Error';
      logger.warn(
        { userId: data.user.id, kind },
        `${kind} email failed: ${reason}`,
      );
    }
  };
  return {
    sendResetPassword: (data: AccountMail) =>
      send(
        'password-reset',
        data,
        passwordResetEmail(data.token, clientAppUrl),
      ),
    sendVerificationEmail: (data: AccountMail) =>
      send('verify-email', data, verificationEmail(data.token, clientAppUrl)),
  };
}
