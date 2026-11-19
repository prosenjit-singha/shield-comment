import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  describeIngestError,
  errorCode,
  isPermanentDbError,
} from '../comments/comment-ingest.rules.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  InvalidModerationJobError,
  MODERATE_COMMENT_JOB_NAME,
  MODERATION_SWEEP_JOB_NAME,
  parseModerateCommentJob,
} from './comment-moderation.job.js';
import {
  type ConfigurableWorker,
  isFinalAttempt,
  type ModerationWorkerSettings,
  startModerationWorker,
} from './comment-moderation.rules.js';
import {
  CommentModerationService,
  type ModerationResult,
  ModerationStepError,
} from './comment-moderation.service.js';
import {
  ModerationSweeper,
  type SweepResult,
} from './comment-moderation.sweeper.js';

const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * `comment-moderation` worker (M5-T12; D3 queue, D2 failure split). Dispatches by job name:
 * `moderate-comment` → `CommentModerationService`, `moderation-sweep` → `ModerationSweeper`.
 *
 * Errors: an invalid job, a non-retryable AI/Graph kind (`not_configured`, `payment_required`,
 * `auth`, `invalid_output`, `token_invalid`, …) or a permanent DB error → `UnrecoverableError`
 * (failed at once); transient kinds and anything else are rethrown → BullMQ retries (5 attempts,
 * exponential 2 s). The service writes `FAILED` itself on the last try.
 *
 * Built with `autorun: false`: `onApplicationBootstrap` applies concurrency + the limiter from the
 * env (decorators run before `.env` is loaded) and then starts it. In e2e the worker is a
 * `FakeWorker` and specs call `process(job)` directly.
 */
@Processor(QUEUE_NAMES.commentModeration, { autorun: false })
export class CommentModerationProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger('CommentModerationWorker');
  private lastWorkerError: { message: string; at: number } | undefined;

  constructor(
    private readonly moderation: CommentModerationService,
    private readonly sweeper: ModerationSweeper,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    const settings: ModerationWorkerSettings = {
      concurrency: this.config.get('MODERATION_WORKER_CONCURRENCY', {
        infer: true,
      }),
      limiter: {
        max: this.config.get('MODERATION_LLM_RATE_MAX', { infer: true }),
        duration: this.config.get('MODERATION_LLM_RATE_DURATION_MS', {
          infer: true,
        }),
      },
    };
    const running = startModerationWorker(
      this.worker as unknown as ConfigurableWorker,
      settings,
    );
    running?.catch((error: unknown) => {
      this.logger.error(
        `Worker ${QUEUE_NAMES.commentModeration} stopped: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });
  }

  async process(
    job: Job<unknown, ModerationResult | SweepResult>,
  ): Promise<ModerationResult | SweepResult> {
    switch (job.name) {
      case MODERATION_SWEEP_JOB_NAME:
        return this.sweeper.sweep();
      case MODERATE_COMMENT_JOB_NAME:
        return this.moderate(job);
      default:
        this.logger.warn(`Job ${job.id ?? '?'} rejected: unknown name`);
        throw new UnrecoverableError('comment-moderation: unknown job name');
    }
  }

  private async moderate(job: Job): Promise<ModerationResult> {
    let target;
    try {
      target = parseModerateCommentJob(job.data);
    } catch (error) {
      if (error instanceof InvalidModerationJobError) {
        this.logger.warn(`Job ${job.id ?? '?'} rejected: ${error.reason}`);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
    try {
      return await this.moderation.moderate(target, {
        finalAttempt: isFinalAttempt(job),
      });
    } catch (error) {
      if (error instanceof ModerationStepError) {
        if (error.retryable) throw error;
        throw new UnrecoverableError(error.message);
      }
      if (isPermanentDbError(error)) {
        const code = errorCode(error) ?? 'unknown';
        this.logger.error(
          `Comment ${target.commentRowId} rejected by the database (${code}); not retried`,
        );
        throw new UnrecoverableError(
          `comment-moderation: database rejected the change (${code})`,
        );
      }
      throw error;
    }
  }

  /** Last attempt failed (or an `UnrecoverableError`): the job lands in the failed set (7 d). */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    const attempts = job?.opts.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    const final =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError' ||
      made >= attempts;
    const line = `Job ${job?.id ?? '?'} failed (attempt ${made}/${attempts}): ${
      error.name === 'UnrecoverableError' ||
      error instanceof ModerationStepError
        ? error.message
        : describeIngestError(error)
    }`;
    if (final) this.logger.error(line);
    else this.logger.warn(line);
  }

  /** Worker connection errors (Redis down): one line per message every 5 min. */
  @OnWorkerEvent('error')
  onError(error: Error): void {
    const now = Date.now();
    const last = this.lastWorkerError;
    if (
      last?.message === error.message &&
      now - last.at < ERROR_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.lastWorkerError = { message: error.message, at: now };
    this.logger.warn(
      `Worker ${QUEUE_NAMES.commentModeration}: ${error.message}`,
    );
  }
}
