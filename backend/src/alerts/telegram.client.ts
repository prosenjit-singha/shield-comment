import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';

/** Telegram Bot API (Module 7 D13): one platform bot, plain `fetch`, no SDK. */
export const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
export const TELEGRAM_SEND_TIMEOUT_MS = 10_000;

export interface TelegramConfig {
  botToken: string;
  /** Without `@`; builds `https://t.me/<bot>?start=<code>`. */
  botUsername: string;
  /** Expected `X-Telegram-Bot-Api-Secret-Token` on `POST /api/telegram/webhook`. */
  webhookSecret: string;
  /** `TELEGRAM_API_BASE_URL` (test stub) or the real API. No trailing slash. */
  apiBaseUrl: string;
}

/** DI token for `TelegramConfig | null` (`null` = the TELEGRAM_* vars are unset). */
export const TELEGRAM_CONFIG = Symbol('TELEGRAM_CONFIG');

/** Env validation already checked the values (all three or none). */
export function createTelegramConfig(
  config: ConfigService<EnvironmentVariables, true>,
): TelegramConfig | null {
  const botToken = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
  const botUsername = config.get('TELEGRAM_BOT_USERNAME', { infer: true });
  const webhookSecret = config.get('TELEGRAM_WEBHOOK_SECRET', { infer: true });
  if (!botToken || !botUsername || !webhookSecret) return null;
  return {
    botToken,
    botUsername,
    webhookSecret,
    apiBaseUrl: (
      config.get('TELEGRAM_API_BASE_URL', { infer: true }) ??
      TELEGRAM_API_BASE_URL
    ).replace(/\/+$/, ''),
  };
}

/**
 * Short error class, stored as `alert_deliveries.error_kind` by M7-T9.
 * `chat_unavailable`: the bot was blocked/removed or the chat is gone; `unauthorized`: bad token.
 */
export type TelegramErrorKind =
  | 'not_configured'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'server_error'
  | 'chat_unavailable'
  | 'unauthorized'
  | 'rejected';

const RETRYABLE: ReadonlySet<TelegramErrorKind> = new Set([
  'timeout',
  'network',
  'rate_limited',
  'server_error',
]);

/** Never contains the bot token or the message text. */
export class TelegramSendError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: TelegramErrorKind,
    /** HTTP status; `null` for network failures, timeouts and `not_configured`. */
    readonly status: number | null,
    /** Telegram's `parameters.retry_after` (seconds) on 429. */
    readonly retryAfterSeconds?: number,
  ) {
    super(
      `Telegram sendMessage failed: ${kind}${status ? ` (${status})` : ''}`,
    );
    this.name = 'TelegramSendError';
    this.retryable = RETRYABLE.has(kind);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Maps a failed Bot API reply to an error kind (pure). */
export function telegramErrorKind(
  status: number,
  description: string,
): TelegramErrorKind {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status === 401 || status === 404) return 'unauthorized';
  if (status === 403 || /chat not found/i.test(description))
    return 'chat_unavailable';
  return 'rejected';
}

@Injectable()
export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);

  constructor(
    @Inject(TELEGRAM_CONFIG) private readonly config: TelegramConfig | null,
  ) {}

  /** Plain text (no parse mode, so nothing to escape), link previews off. Resolves the message id. */
  async sendMessage(chatId: number, text: string): Promise<number> {
    const config = this.config;
    if (!config) throw new TelegramSendError('not_configured', null);
    let res: Response;
    try {
      res = await fetch(
        `${config.apiBaseUrl}/bot${config.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            link_preview_options: { is_disabled: true },
          }),
          signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw this.failed(
        new TelegramSendError(
          error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : 'network',
          null,
        ),
      );
    }
    const body: unknown = await res.json().catch(() => undefined);
    const result = isRecord(body) ? body.result : undefined;
    if (res.ok && isRecord(body) && body.ok === true && isRecord(result)) {
      return typeof result.message_id === 'number' ? result.message_id : 0;
    }
    const description =
      isRecord(body) && typeof body.description === 'string'
        ? body.description
        : '';
    const params = isRecord(body) ? body.parameters : undefined;
    const retryAfter =
      isRecord(params) && typeof params.retry_after === 'number'
        ? params.retry_after
        : undefined;
    // A 200 without `ok: true` is odd; treat it as a server-side problem.
    const status = res.ok ? 502 : res.status;
    throw this.failed(
      new TelegramSendError(
        telegramErrorKind(status, description),
        res.status,
        retryAfter,
      ),
    );
  }

  private failed(error: TelegramSendError): TelegramSendError {
    this.logger.warn(
      `telegram send failed: kind=${error.kind} status=${error.status ?? 'none'} retryable=${error.retryable}`,
    );
    return error;
  }
}
