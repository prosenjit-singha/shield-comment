import { dhakaDateTime } from '../comments/analytics.js';
import { type EmailContent, bilingualEmail } from '../email/bilingual-email.js';
import {
  EmailNotConfiguredError,
  EmailSendError,
} from '../email/email.service.js';
import { TelegramSendError } from './telegram.client.js';

/**
 * Pure rules + copy of scam-spike alerts (M7-T9; Module 7 D14/D15, readings 8–12).
 * No DB, no Redis: the detector, the dispatcher and the test route use these.
 */

/** D14: rolling 60-minute window. */
export const SCAM_WINDOW_MINUTES = 60;
export const SCAM_WINDOW_MS = SCAM_WINDOW_MINUTES * 60_000;
/** D14: at most one real alert per workspace per hour (Redis `SET NX EX`). */
export const ALERT_COOLDOWN_SECONDS = 60 * 60;
/** Reading 12: "Send test alert" at most 5 times per workspace per hour. */
export const TEST_ALERTS_PER_HOUR = 5;
export const TEST_ALERT_WINDOW_SECONDS = 60 * 60;
/** Redis call budget of the detector (it runs inside the moderation worker). */
export const SPIKE_DETECT_TIMEOUT_MS = 2_000;

export const SCAM_SPIKE_JOB_NAME = 'scam-spike';

/** Reading 8: what counts as a scam outcome (rule matches store no category, M6 D2). */
export const SCAM_CATEGORY = 'SCAM_PHISHING';
export const SCAM_RULE_REASONS = ['rule_url', 'rule_phone'] as const;

export const alertCooldownKey = (workspaceId: string) =>
  `alerts:cooldown:${workspaceId}`;
export const testAlertRateKey = (workspaceId: string) =>
  `alerts:test:${workspaceId}`;

/** D14: the count reached the threshold. */
export function spikeReached(scamCount: number, threshold: number): boolean {
  return scamCount >= threshold;
}

/**
 * One job per workspace + hour bucket (3 parts, the only `:` form BullMQ accepts). The 60-minute
 * cool-down means two real alerts never share a bucket; a lost cool-down key still dedupes here.
 */
export function scamSpikeJobId(workspaceId: string, at: Date): string {
  return `${SCAM_SPIKE_JOB_NAME}:${workspaceId}:${Math.floor(at.getTime() / 3_600_000)}`;
}

export interface ScamSpikeJobData {
  workspaceId: string;
  scamCount: number;
  threshold: number;
  /** ISO time the spike was detected. */
  detectedAt: string;
  /** Target keys already delivered by an earlier attempt (`job.updateData`), never re-sent. */
  sent?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `null` = invalid (the worker fails the job without retries). */
export function parseScamSpikeJob(data: unknown): ScamSpikeJobData | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.workspaceId !== 'string' || !UUID.test(d.workspaceId))
    return null;
  if (!Number.isInteger(d.scamCount) || (d.scamCount as number) < 0)
    return null;
  if (!Number.isInteger(d.threshold) || (d.threshold as number) < 1)
    return null;
  if (
    typeof d.detectedAt !== 'string' ||
    Number.isNaN(Date.parse(d.detectedAt))
  )
    return null;
  const sent = d.sent ?? [];
  if (!Array.isArray(sent) || !sent.every((s) => typeof s === 'string'))
    return null;
  return {
    workspaceId: d.workspaceId,
    scamCount: d.scamCount as number,
    threshold: d.threshold as number,
    detectedAt: d.detectedAt,
    sent: sent as string[],
  };
}

/** Short error class for `alert_deliveries.error_kind` (same words as `TelegramSendError.kind`). */
export interface SendFailure {
  kind: string;
  retryable: boolean;
}

/** Maps a failed email / Telegram send. Unknown errors are retried as `unknown`. */
export function sendFailure(error: unknown): SendFailure {
  if (error instanceof TelegramSendError)
    return { kind: error.kind, retryable: error.retryable };
  if (error instanceof EmailNotConfiguredError)
    return { kind: 'not_configured', retryable: false };
  if (error instanceof EmailSendError) {
    const kind =
      error.status === null
        ? 'network'
        : error.status === 429
          ? 'rate_limited'
          : error.status >= 500
            ? 'server_error'
            : 'rejected';
    return { kind, retryable: error.retryable };
  }
  return { kind: 'unknown', retryable: true };
}

/** One recipient or chat of a channel. `key` is stable across retries. */
export interface AlertTarget {
  key: string;
  channel: 'EMAIL' | 'TELEGRAM';
}

export type TargetResult =
  | { key: string; channel: 'EMAIL' | 'TELEGRAM'; ok: true }
  | ({ key: string; channel: 'EMAIL' | 'TELEGRAM'; ok: false } & SendFailure);

export interface ChannelOutcome {
  channel: 'EMAIL' | 'TELEGRAM';
  status: 'SENT' | 'FAILED';
  errorKind: string | null;
}

/**
 * One row per channel: SENT when every target got it, else FAILED with the first failure's kind.
 * `pending` = a retryable failure while attempts are left (the job retries; no rows yet).
 */
export function channelOutcomes(
  results: readonly TargetResult[],
  finalAttempt: boolean,
): { pending: boolean; outcomes: ChannelOutcome[] } {
  const pending = !finalAttempt && results.some((r) => !r.ok && r.retryable);
  const outcomes: ChannelOutcome[] = [];
  for (const channel of ['EMAIL', 'TELEGRAM'] as const) {
    const mine = results.filter((r) => r.channel === channel);
    if (mine.length === 0) continue;
    const failed = mine.find((r) => !r.ok);
    outcomes.push(
      failed && !failed.ok
        ? { channel, status: 'FAILED', errorKind: failed.kind }
        : { channel, status: 'SENT', errorKind: null },
    );
  }
  return { pending, outcomes };
}

/** What every alert message says (no comment text, no author ids: reading 10). */
export interface AlertCopyInput {
  workspaceName: string;
  scamCount: number;
  threshold: number;
  at: Date;
}

const base = (clientAppUrl: string) => clientAppUrl.replace(/\/+$/, '');
export const spikeAlertUrl = (clientAppUrl: string) =>
  `${base(clientAppUrl)}/dashboard`;
export const testAlertUrl = (clientAppUrl: string) =>
  `${base(clientAppUrl)}/settings/alerts`;

/** `YYYY-MM-DD HH:mm` in Asia/Dhaka (D14). */
const dhaka = (at: Date) => dhakaDateTime(at).slice(0, 16);

function spikeLines(input: AlertCopyInput) {
  const time = dhaka(input.at);
  return {
    en: {
      subject: `Scam spike: ${input.scamCount} scam comments in the last hour`,
      lines: [
        `${input.scamCount} scam comments arrived on "${input.workspaceName}" in the last ${SCAM_WINDOW_MINUTES} minutes (your alert threshold is ${input.threshold}).`,
        `Detected at ${time} (Dhaka time). ShieldComment keeps moderating; open your dashboard to review them.`,
        `You get at most one alert per hour.`,
      ],
    },
    bn: {
      subject: `স্ক্যাম বেড়েছে: গত এক ঘণ্টায় ${input.scamCount}টি স্ক্যাম কমেন্ট`,
      lines: [
        `গত ${SCAM_WINDOW_MINUTES} মিনিটে "${input.workspaceName}"-এ ${input.scamCount}টি স্ক্যাম কমেন্ট এসেছে (আপনার অ্যালার্ট সীমা ${input.threshold})।`,
        `শনাক্তের সময় ${time} (ঢাকা সময়)। ShieldComment মডারেশন চালিয়ে যাচ্ছে; দেখতে ড্যাশবোর্ড খুলুন।`,
        `ঘণ্টায় সর্বোচ্চ একটি অ্যালার্ট পাঠানো হয়।`,
      ],
    },
  };
}

function testLines(input: AlertCopyInput) {
  return {
    en: {
      subject: 'Test alert from ShieldComment',
      lines: [
        `This is a test alert for "${input.workspaceName}". Alerts reach you here.`,
        `A real alert is sent when scam comments in the last ${SCAM_WINDOW_MINUTES} minutes reach ${input.threshold}.`,
      ],
    },
    bn: {
      subject: 'ShieldComment থেকে পরীক্ষামূলক অ্যালার্ট',
      lines: [
        `এটি "${input.workspaceName}"-এর একটি পরীক্ষামূলক অ্যালার্ট। অ্যালার্ট এখানেই আসবে।`,
        `গত ${SCAM_WINDOW_MINUTES} মিনিটে স্ক্যাম কমেন্ট ${input.threshold}টিতে পৌঁছালে আসল অ্যালার্ট পাঠানো হয়।`,
      ],
    },
  };
}

export function alertEmail(
  kind: 'spike' | 'test',
  input: AlertCopyInput,
  clientAppUrl: string,
): EmailContent {
  const copy = kind === 'spike' ? spikeLines(input) : testLines(input);
  const url =
    kind === 'spike' ? spikeAlertUrl(clientAppUrl) : testAlertUrl(clientAppUrl);
  return bilingualEmail(
    {
      en: {
        ...copy.en,
        cta: {
          label: kind === 'spike' ? 'Open dashboard' : 'Alert settings',
          url,
        },
      },
      bn: {
        ...copy.bn,
        cta: {
          label: kind === 'spike' ? 'ড্যাশবোর্ড খুলুন' : 'অ্যালার্ট সেটিংস',
          url,
        },
      },
    },
    clientAppUrl,
  );
}

/** Plain text (the client sends no parse mode): English, then Bangla, then the link. */
export function alertTelegramText(
  kind: 'spike' | 'test',
  input: AlertCopyInput,
  clientAppUrl: string,
): string {
  const copy = kind === 'spike' ? spikeLines(input) : testLines(input);
  const url =
    kind === 'spike' ? spikeAlertUrl(clientAppUrl) : testAlertUrl(clientAppUrl);
  return [
    `⚠️ ${copy.en.subject}`,
    ...copy.en.lines,
    '',
    `⚠️ ${copy.bn.subject}`,
    ...copy.bn.lines,
    '',
    url,
  ].join('\n');
}
