import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Queue } from 'bullmq';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { withTimeout } from '../common/async/with-timeout.js';
import type { Database } from '../db/database.js';
import { alertSettings, comments } from '../db/schema/index.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import { messengerAlertsAvailable } from './alert-settings.service.js';
import { AlertStore } from './alert.store.js';
import {
  ALERT_COOLDOWN_SECONDS,
  alertCooldownKey,
  SCAM_CATEGORY,
  SCAM_RULE_REASONS,
  SCAM_SPIKE_JOB_NAME,
  SCAM_WINDOW_MS,
  type ScamSpikeJobData,
  scamSpikeJobId,
  SPIKE_DETECT_TIMEOUT_MS,
  spikeReached,
} from './scam-spike.js';

/** Why the detector stopped (tests + debug logs). */
export type SpikeCheck =
  'alerts_off' | 'not_scam' | 'below_threshold' | 'cooling_down' | 'enqueued';

/** Reading 8: a scam outcome = the AI category or a URL / phone rule match. */
const isScam = or(
  eq(comments.category, SCAM_CATEGORY),
  inArray(comments.statusReason, [...SCAM_RULE_REASONS]),
);

/**
 * D14 spike detector (M7-T9), called by the moderation worker after a comment's outcome is saved.
 * Alerts on → this comment is a scam → scam comments created in the last 60 min ≥ threshold →
 * cool-down `SET NX EX 3600` → `scam-spike` job on `alerts`. Never throws: a DB / Redis / queue
 * failure is logged and moderation goes on (reading 9). A failed enqueue gives the cool-down back.
 */
@Injectable()
export class ScamSpikeDetector {
  private readonly logger = new Logger('ScamSpikeDetector');

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly store: AlertStore,
    @InjectQueue(QUEUE_NAMES.alerts) private readonly queue: Queue,
  ) {}

  async afterModeration(
    workspaceId: string,
    commentRowId: string,
    now: Date = new Date(),
  ): Promise<SpikeCheck | 'error'> {
    try {
      return await withTimeout(
        this.check(workspaceId, commentRowId, now),
        SPIKE_DETECT_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger.warn(
        `Spike check for workspace ${workspaceId} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return 'error';
    }
  }

  private async check(
    workspaceId: string,
    commentRowId: string,
    now: Date,
  ): Promise<SpikeCheck> {
    const [settings] = await this.db
      .select({
        threshold: alertSettings.spikeThreshold,
        email: alertSettings.emailEnabled,
        telegram: alertSettings.telegramEnabled,
      })
      .from(alertSettings)
      .where(eq(alertSettings.workspaceId, workspaceId));
    if (!settings || (!settings.email && !settings.telegram))
      return 'alerts_off';

    const since = new Date(now.getTime() - SCAM_WINDOW_MS).toISOString();
    const [counts] = await this.db
      .select({
        recent:
          sql<number>`count(*) filter (where ${comments.createdAt} >= ${since}::timestamptz)`.mapWith(
            Number,
          ),
        current: sql<boolean>`coalesce(bool_or(${comments.id} = ${commentRowId}), false)`,
      })
      .from(comments)
      .where(
        and(
          eq(comments.workspaceId, workspaceId),
          isScam,
          or(
            sql`${comments.createdAt} >= ${since}::timestamptz`,
            eq(comments.id, commentRowId),
          ),
        ),
      );
    if (!counts?.current) return 'not_scam';
    if (!spikeReached(counts.recent, settings.threshold))
      return 'below_threshold';
    // D12: email is on every plan; Telegram only with `messengerAlerts`.
    if (
      !settings.email &&
      !(await messengerAlertsAvailable(this.db, workspaceId))
    )
      return 'alerts_off';

    const key = alertCooldownKey(workspaceId);
    if (!(await this.store.claim(key, ALERT_COOLDOWN_SECONDS)))
      return 'cooling_down';
    const data: ScamSpikeJobData = {
      workspaceId,
      scamCount: counts.recent,
      threshold: settings.threshold,
      detectedAt: now.toISOString(),
    };
    try {
      await this.queue.add(SCAM_SPIKE_JOB_NAME, data, {
        jobId: scamSpikeJobId(workspaceId, now),
      });
    } catch (error) {
      await this.store.release(key).catch(() => undefined);
      throw error;
    }
    this.logger.log(
      `Scam spike in workspace ${workspaceId}: ${counts.recent} in ${SCAM_WINDOW_MS / 60_000} min (threshold ${settings.threshold}), alert queued`,
    );
    return 'enqueued';
  }
}
