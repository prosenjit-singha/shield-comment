import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  NodeEnv,
  type EnvironmentVariables,
} from '../config/env.validation.js';

/** Resend HTTP API (Module 7 D6): one POST per email, no SDK. */
export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
export const EMAIL_SEND_TIMEOUT_MS = 10_000;
/** Provider messages are short; cap them anyway so an odd body can't flood logs. */
const MESSAGE_MAX = 300;

export interface ResendConfig {
  apiKey: string;
  /** `address@domain` or `Name <address@domain>` on a domain verified in Resend. */
  from: string;
}

/** DI token for `EmailSettings`. */
export const EMAIL_SETTINGS = Symbol('EMAIL_SETTINGS');

export interface EmailSettings {
  /** `null` when `RESEND_API_KEY` / `EMAIL_FROM` are unset (env validation: both or neither). */
  resend: ResendConfig | null;
  production: boolean;
}

export function createEmailSettings(
  config: ConfigService<EnvironmentVariables, true>,
): EmailSettings {
  const apiKey = config.get('RESEND_API_KEY', { infer: true });
  const from = config.get('EMAIL_FROM', { infer: true });
  return {
    resend: apiKey && from ? { apiKey, from } : null,
    production: config.get('NODE_ENV', { infer: true }) === NodeEnv.Production,
  };
}

export interface EmailMessage {
  /** One recipient address. */
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend `Idempotency-Key` (24 h): pass a stable key when a retried job may send twice. */
  idempotencyKey?: string;
}

export type EmailSendResult =
  | { delivered: true; id: string }
  | { delivered: false; reason: 'not_configured' };

/** Production without `RESEND_API_KEY` + `EMAIL_FROM`; callers catch it (an email never fails the main action). */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Email is not configured (RESEND_API_KEY, EMAIL_FROM)');
    this.name = 'EmailNotConfiguredError';
  }
}

/** Provider failure. `retryable`: network, timeout, 429, 5xx. Never contains the key or the recipient. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    /** HTTP status; `null` for network failures and timeouts. */
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recipientDomain(to: string): string {
  return to.slice(to.lastIndexOf('@') + 1) || 'unknown';
}

/**
 * Transactional email (M7-T1). Logs carry the recipient domain + Resend's message id only.
 * Not configured: outside production the email is logged (to + subject) and `send` resolves
 * `{ delivered: false }`; in production `send` throws `EmailNotConfiguredError`.
 * e2e specs override it with `createEmailServiceFake()` (`test/utils/fake-email.ts`).
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(EMAIL_SETTINGS) private readonly settings: EmailSettings,
  ) {}

  get enabled(): boolean {
    return this.settings.resend !== null;
  }

  onModuleInit(): void {
    if (this.settings.resend) return;
    if (this.settings.production) {
      this.logger.error(
        'Email is not configured (RESEND_API_KEY, EMAIL_FROM): every email send fails',
      );
    } else {
      this.logger.log(
        'Email is not configured: emails are logged (to, subject), not sent',
      );
    }
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const resend = this.settings.resend;
    if (!resend) {
      if (this.settings.production) throw new EmailNotConfiguredError();
      this.logger.log(
        `email not sent (not configured): to=${message.to} subject=${JSON.stringify(message.subject)}`,
      );
      return { delivered: false, reason: 'not_configured' };
    }
    const domain = recipientDomain(message.to);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${resend.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (message.idempotencyKey) {
      headers['Idempotency-Key'] = message.idempotencyKey;
    }
    let res: Response;
    try {
      res = await fetch(RESEND_EMAILS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: resend.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `timed out after ${EMAIL_SEND_TIMEOUT_MS} ms`
          : 'request failed';
      throw this.failed(
        domain,
        new EmailSendError(`Resend: ${reason}`, null, true),
      );
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const raw =
        isRecord(body) && typeof body.message === 'string'
          ? body.message
          : `HTTP ${res.status}`;
      // Resend may echo the address back (422 "Invalid `to` field …").
      const text = raw
        .split(message.to)
        .join('[recipient]')
        .slice(0, MESSAGE_MAX);
      const retryable = res.status === 429 || res.status >= 500;
      throw this.failed(
        domain,
        new EmailSendError(
          `Resend ${res.status}: ${text}`,
          res.status,
          retryable,
        ),
      );
    }
    const id = isRecord(body) && typeof body.id === 'string' ? body.id : '';
    if (!id) {
      // Accepted but unreadable: retrying could send it twice.
      throw this.failed(
        domain,
        new EmailSendError(
          `Resend ${res.status}: response without an email id`,
          res.status,
          false,
        ),
      );
    }
    this.logger.log(`email sent: domain=${domain} id=${id}`);
    return { delivered: true, id };
  }

  private failed(domain: string, error: EmailSendError): EmailSendError {
    this.logger.warn(
      `email failed: domain=${domain} status=${error.status ?? 'network'} retryable=${error.retryable}`,
    );
    return error;
  }
}
