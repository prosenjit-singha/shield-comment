import { bilingualEmail, type EmailContent } from '../email/bilingual-email.js';
import { DHAKA_OFFSET_MS } from '../wallet/wallet-period.js';

/**
 * Renewal reminder rules (M8-T6; user decision 2026-11-21 D4: manual renewal, emails 7, 3 and 1
 * days before the term end and once on expiry). Pure: no I/O, `now` is passed in.
 */

const DAY_MS = 86_400_000;

/** A reminder as days before the term end; 0 = the expiry email. */
export type ReminderDays = 7 | 3 | 1 | 0;

/** Asia/Dhaka calendar days from `now`'s day to `end`'s day (UTC+6, no DST). */
export function dhakaDaysUntil(end: Date, now: Date): number {
  const day = (d: Date) => Math.floor((d.getTime() + DHAKA_OFFSET_MS) / DAY_MS);
  return day(end) - day(now);
}

/**
 * The reminder due for a term ending at `termEnd`: 7 (3 < days left ≤ 7), 3 (1 < days ≤ 3),
 * 1 (the last day or the day of the end, before it), 0 once `now ≥ termEnd`, `null` more than
 * 7 Dhaka days before. A late daily run sends the stage it is in (never a backlog).
 */
export function dueReminder(termEnd: Date, now: Date): ReminderDays | null {
  if (now.getTime() >= termEnd.getTime()) return 0;
  const days = dhakaDaysUntil(termEnd, now);
  if (days > 7) return null;
  if (days > 3) return 7;
  if (days > 1) return 3;
  return 1;
}

/** The marker already covers this reminder: same term end and this stage or a later one sent. */
export function reminderSent(
  marker: { termEnd: Date | null; days: number | null },
  termEnd: Date,
  days: ReminderDays,
): boolean {
  return (
    marker.termEnd?.getTime() === termEnd.getTime() &&
    marker.days !== null &&
    marker.days <= days
  );
}

const dhakaDate = (at: Date, locale: 'en-GB' | 'bn-BD') =>
  new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Dhaka',
  }).format(at);

/** The bilingual owner email (CTA `CLIENT_APP_URL/billing`). */
export function renewalReminderEmail(
  input: { days: ReminderDays; termEnd: Date; planName: string },
  clientAppUrl: string,
): EmailContent {
  const url = `${clientAppUrl.replace(/\/+$/, '')}/billing`;
  const { days, planName } = input;
  const en = dhakaDate(input.termEnd, 'en-GB');
  const bn = dhakaDate(input.termEnd, 'bn-BD');
  if (days === 0) {
    return bilingualEmail(
      {
        en: {
          subject: 'Your ShieldComment plan has ended',
          lines: [
            `Your ${planName} plan ended on ${en} (Bangladesh time). Comment moderation is paused; nothing was deleted.`,
            'Pay for a new term to turn moderation back on.',
          ],
          cta: { label: 'Choose a plan', url },
        },
        bn: {
          subject: 'আপনার ShieldComment প্ল্যান শেষ হয়েছে',
          lines: [
            `আপনার ${planName} প্ল্যান ${bn} (বাংলাদেশ সময়) শেষ হয়েছে। কমেন্ট মডারেশন বন্ধ আছে; কিছুই মুছে ফেলা হয়নি।`,
            'মডারেশন আবার চালু করতে নতুন মেয়াদের জন্য পেমেন্ট করুন।',
          ],
          cta: { label: 'প্ল্যান বেছে নিন', url },
        },
      },
      clientAppUrl,
    );
  }
  const bnDays = new Intl.NumberFormat('bn-BD').format(days);
  return bilingualEmail(
    {
      en: {
        subject: `Your ShieldComment plan ends in ${days} ${days === 1 ? 'day' : 'days'}`,
        lines: [
          `Your ${planName} plan ends on ${en} (Bangladesh time).`,
          'Renew now to keep moderation running. An early payment adds a full term from the current end, so you lose nothing.',
        ],
        cta: { label: 'Renew plan', url },
      },
      bn: {
        subject: `আপনার ShieldComment প্ল্যান ${bnDays} দিনের মধ্যে শেষ হবে`,
        lines: [
          `আপনার ${planName} প্ল্যান ${bn} (বাংলাদেশ সময়) শেষ হবে।`,
          'মডারেশন চালু রাখতে এখনই রিনিউ করুন। আগে পেমেন্ট করলে বর্তমান মেয়াদ শেষ হওয়ার পর থেকে পুরো নতুন মেয়াদ যোগ হয়, তাই কিছুই হারাবেন না।',
        ],
        cta: { label: 'প্ল্যান রিনিউ করুন', url },
      },
    },
    clientAppUrl,
  );
}
