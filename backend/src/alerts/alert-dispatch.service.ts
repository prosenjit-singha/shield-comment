import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { asc, eq } from 'drizzle-orm';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import {
  alertDeliveries,
  alertSettings,
  telegramChats,
  workspaces,
} from '../db/schema/index.js';
import {
  EmailNotConfiguredError,
  EmailService,
} from '../email/email.service.js';
import {
  messengerAlertsAvailable,
  workspaceRecipients,
} from './alert-settings.service.js';
import {
  DEFAULT_ALERT_SETTINGS,
  resolveRecipients,
} from './alert-settings.rules.js';
import { AlertStore } from './alert.store.js';
import type { AlertRecipient } from './dto/alert-settings.dto.js';
import {
  type AlertCopyInput,
  alertEmail,
  alertTelegramText,
  type ChannelOutcome,
  channelOutcomes,
  type ScamSpikeJobData,
  sendFailure,
  TEST_ALERT_WINDOW_SECONDS,
  TEST_ALERTS_PER_HOUR,
  type TargetResult,
  testAlertRateKey,
} from './scam-spike.js';
import { TelegramClient } from './telegram.client.js';

/** Codes of `POST /api/workspaces/:workspaceId/alerts/test`. */
export const ALERT_TEST_ERROR_CODES = {
  /** 409: no channel would send (email off, Telegram off / not on the plan / no chat linked). */
  noChannel: 'ALERT_NO_CHANNEL',
  /** 429: more than 5 test alerts in an hour; `details { max }`. */
  rateLimited: 'ALERT_TEST_RATE_LIMITED',
} as const;

export interface TestAlertResponse {
  deliveries: ChannelOutcome[];
}

/** Where an alert goes right now (reading 11: gated by the live plan at send time). */
interface AlertPlan {
  workspaceName: string;
  threshold: number;
  emails: AlertRecipient[];
  chats: { id: string; telegramChatId: number }[];
}

/** A retryable failure with attempts left: the `scam-spike` job retries (BullMQ backoff). */
export class AlertRetryError extends Error {
  constructor(readonly kinds: string[]) {
    super(`scam-spike: retryable send failure (${kinds.join(', ')})`);
    this.name = 'AlertRetryError';
  }
}

export type ScamSpikeOutcome =
  | { kind: 'delivered'; deliveries: ChannelOutcome[] }
  | { kind: 'skipped'; reason: 'no_channel' };

/**
 * Sends scam-spike alerts and test alerts (M7-T9; D12/D15, readings 10–12) and writes
 * `alert_deliveries` (one row per channel). Logs ids, counts and kinds only: never addresses,
 * chat ids or message text.
 */
@Injectable()
export class AlertDispatchService {
  private readonly logger = new Logger('Alerts');
  private readonly clientAppUrl: string;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly email: EmailService,
    private readonly telegram: TelegramClient,
    private readonly store: AlertStore,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.clientAppUrl =
      config.get('CLIENT_APP_URL', { infer: true }) ?? DEFAULT_CLIENT_APP_URL;
  }

  /**
   * The `scam-spike` job. Targets delivered by an earlier attempt (`data.sent`) are skipped;
   * `saveSent` stores the new list on the job before anything can throw. A retryable failure with
   * attempts left → `AlertRetryError` (no rows yet); otherwise one row per channel.
   */
  async dispatchSpike(
    data: ScamSpikeJobData,
    jobId: string,
    attempt: {
      finalAttempt: boolean;
      saveSent: (sent: string[]) => Promise<void>;
    },
  ): Promise<ScamSpikeOutcome> {
    const plan = await this.plan(data.workspaceId);
    if (plan.emails.length === 0 && plan.chats.length === 0)
      return { kind: 'skipped', reason: 'no_channel' };
    const sent = new Set(data.sent);
    const before = sent.size;
    const results = await this.deliver(
      'spike',
      plan,
      {
        workspaceName: plan.workspaceName,
        scamCount: data.scamCount,
        threshold: data.threshold,
        at: new Date(data.detectedAt),
      },
      `alert:${jobId}`,
      sent,
    );
    if (sent.size > before) await attempt.saveSent([...sent]);
    const { pending, outcomes } = channelOutcomes(
      results,
      attempt.finalAttempt,
    );
    if (pending)
      throw new AlertRetryError(results.flatMap((r) => (r.ok ? [] : [r.kind])));
    await this.record(data.workspaceId, outcomes, data.scamCount, false);
    this.logger.log(
      `Scam spike alert for workspace ${data.workspaceId} (${data.scamCount} scams): ${outcomes.map((o) => `${o.channel} ${o.status}${o.errorKind ? ` ${o.errorKind}` : ''}`).join(', ')}`,
    );
    return { kind: 'delivered', deliveries: outcomes };
  }

  /**
   * Reading 12: the channels a real alert would use right now, no cool-down effect, ≤ 5 per
   * workspace per hour. Rows are written with `is_test` (never the "last alert").
   */
  async sendTest(
    workspaceId: string,
    actor: { userId: string; impersonatedBy: string | null },
  ): Promise<TestAlertResponse> {
    const plan = await this.plan(workspaceId);
    if (plan.emails.length === 0 && plan.chats.length === 0)
      throw new ConflictException({
        message:
          'Switch on email or Telegram alerts (with a linked chat) to send a test alert.',
        error: 'Conflict',
        code: ALERT_TEST_ERROR_CODES.noChannel,
      });
    const hits = await this.store.hit(
      testAlertRateKey(workspaceId),
      TEST_ALERT_WINDOW_SECONDS,
    );
    if (hits > TEST_ALERTS_PER_HOUR)
      throw new HttpException(
        {
          message: `At most ${TEST_ALERTS_PER_HOUR} test alerts per hour. Try again later.`,
          error: 'Too Many Requests',
          code: ALERT_TEST_ERROR_CODES.rateLimited,
          details: { max: TEST_ALERTS_PER_HOUR },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const results = await this.deliver(
      'test',
      plan,
      {
        workspaceName: plan.workspaceName,
        scamCount: 0,
        threshold: plan.threshold,
        at: new Date(),
      },
      `alert-test:${crypto.randomUUID()}`,
      new Set(),
    );
    const { outcomes } = channelOutcomes(results, true);
    await this.record(workspaceId, outcomes, 0, true);
    this.logger.log(
      `Test alert for workspace ${workspaceId} by user ${actor.userId}${actor.impersonatedBy ? ` (impersonated by ${actor.impersonatedBy})` : ''}: ${outcomes.map((o) => `${o.channel} ${o.status}`).join(', ')}`,
    );
    return { deliveries: outcomes };
  }

  /** Settings + live plan + members + chats, read fresh (reading 11). */
  private async plan(workspaceId: string): Promise<AlertPlan> {
    const [settings] = await this.db
      .select()
      .from(alertSettings)
      .where(eq(alertSettings.workspaceId, workspaceId));
    const [workspace] = await this.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const values = settings ?? DEFAULT_ALERT_SETTINGS;
    const emails = values.emailEnabled
      ? resolveRecipients(
          values.emailRecipientMemberIds,
          await workspaceRecipients(this.db, workspaceId),
        )
      : [];
    const chats =
      values.telegramEnabled &&
      (await messengerAlertsAvailable(this.db, workspaceId))
        ? await this.db
            .select({
              id: telegramChats.id,
              telegramChatId: telegramChats.telegramChatId,
            })
            .from(telegramChats)
            .where(eq(telegramChats.workspaceId, workspaceId))
            .orderBy(asc(telegramChats.linkedAt), asc(telegramChats.id))
        : [];
    return {
      workspaceName: workspace?.name ?? 'your workspace',
      threshold: values.spikeThreshold,
      emails,
      chats,
    };
  }

  /** Sends to every target not in `sent` (one at a time); adds each success to `sent`. */
  private async deliver(
    kind: 'spike' | 'test',
    plan: AlertPlan,
    copy: AlertCopyInput,
    idempotencyPrefix: string,
    sent: Set<string>,
  ): Promise<TargetResult[]> {
    const results: TargetResult[] = [];
    const run = async (
      key: string,
      channel: 'EMAIL' | 'TELEGRAM',
      send: () => Promise<void>,
    ) => {
      if (sent.has(key)) {
        results.push({ key, channel, ok: true });
        return;
      }
      try {
        await send();
        sent.add(key);
        results.push({ key, channel, ok: true });
      } catch (error) {
        results.push({ key, channel, ok: false, ...sendFailure(error) });
      }
    };

    if (plan.emails.length > 0) {
      const content = alertEmail(kind, copy, this.clientAppUrl);
      for (const member of plan.emails) {
        await run(`email:${member.memberId}`, 'EMAIL', async () => {
          const result = await this.email.send({
            to: member.email,
            ...content,
            idempotencyKey: `${idempotencyPrefix}:${member.memberId}`,
          });
          // Dev/test without Resend resolves `{ delivered: false }`: stored as `not_configured`.
          if (!result.delivered) throw new EmailNotConfiguredError();
        });
      }
    }
    if (plan.chats.length > 0) {
      const text = alertTelegramText(kind, copy, this.clientAppUrl);
      for (const chat of plan.chats) {
        await run(`telegram:${chat.id}`, 'TELEGRAM', async () => {
          await this.telegram.sendMessage(chat.telegramChatId, text);
        });
      }
    }
    return results;
  }

  private async record(
    workspaceId: string,
    outcomes: readonly ChannelOutcome[],
    scamCount: number,
    isTest: boolean,
  ): Promise<void> {
    if (outcomes.length === 0) return;
    await this.db.insert(alertDeliveries).values(
      outcomes.map((o) => ({
        workspaceId,
        channel: o.channel,
        status: o.status,
        errorKind: o.errorKind,
        scamCount,
        isTest,
      })),
    );
  }
}
