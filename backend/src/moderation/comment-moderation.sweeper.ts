import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Queue } from 'bullmq';
import { withTimeout } from '../common/async/with-timeout.js';
import type { Database } from '../db/database.js';
import { SCHEDULE_TIME_ZONE } from '../meta-callbacks/meta-scheduled.jobs.js';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  MODERATION_SWEEP_BATCH,
  MODERATION_SWEEP_IDLE_MS,
  MODERATION_SWEEP_JOB_NAME,
  MODERATION_SWEEP_MAX_AGE_MS,
  MODERATION_SWEEP_PATTERN,
  MODERATION_SWEEP_SCHEDULER_ID,
  moderateCommentJob,
} from './comment-moderation.job.js';
import { findSweepCandidates } from './comment-moderation.queries.js';

/** The part of a BullMQ `Queue` the sweeper uses (FakeQueue in e2e has it too). */
export type SweepQueue = Pick<Queue, 'add' | 'getJobState' | 'remove'>;

export interface SweepResult {
  /** Comments found (stage set, < 24 h, idle ≥ 5 min). */
  candidates: number;
  /** New jobs added (a failed/completed job with the same id was removed first). */
  requeued: number;
  /** A job for that version is still waiting/delayed/active: left alone. */
  queued: number;
}

/** Job states in which the version's job will still run: the sweeper leaves it alone. */
const LIVE_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'waiting-children',
  'delayed',
  'prioritized',
  'active',
]);

/**
 * D2 sweeper (M5-T12): re-queues comments that still owe moderation (`moderation_stage` set:
 * `PENDING`, `FAILED`, or an edit not re-checked) whose text is younger than 24 h. Uses the same
 * job id as the hand-off (`moderationJobId`): a job that is still queued is left alone; a
 * failed/completed one is removed first (BullMQ would ignore an `add` with its id). Logs counts.
 */
@Injectable()
export class ModerationSweeper {
  private readonly logger = new Logger('ModerationSweeper');

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @InjectQueue(QUEUE_NAMES.commentModeration)
    private readonly queue: SweepQueue,
  ) {}

  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const candidates = await findSweepCandidates(this.db, {
      since: new Date(now.getTime() - MODERATION_SWEEP_MAX_AGE_MS),
      idleBefore: new Date(now.getTime() - MODERATION_SWEEP_IDLE_MS),
      limit: MODERATION_SWEEP_BATCH,
    });
    let requeued = 0;
    let queued = 0;
    for (const candidate of candidates) {
      const job = moderateCommentJob({
        workspaceId: candidate.workspaceId,
        commentRowId: candidate.id,
        editedAt: candidate.editedAt,
      });
      const id = job.opts.jobId!;
      const state = await this.queue.getJobState(id);
      if (LIVE_STATES.has(state)) {
        queued += 1;
        continue;
      }
      if (state !== 'unknown' && (await this.queue.remove(id)) === 0) {
        // Locked: a worker picked it up meanwhile.
        queued += 1;
        continue;
      }
      await this.queue.add(job.name, job.data, job.opts);
      requeued += 1;
    }
    const result = { candidates: candidates.length, requeued, queued };
    if (candidates.length > 0) {
      this.logger.log(
        `Sweep: ${result.candidates} comments owe moderation, ${result.requeued} re-queued, ${result.queued} still queued`,
      );
    }
    return result;
  }
}

/** How long boot-time registration waits for Redis before it logs a warning. */
export const MODERATION_SCHEDULER_TIMEOUT_MS = 5_000;

/** Sweep ticks: one attempt (the next tick is 15 min later), bounded history. */
export const MODERATION_SWEEP_JOB_OPTIONS = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 1,
};

/**
 * Registers the sweep job scheduler on `comment-moderation` at startup (pattern of
 * `MetaJobSchedulers`): in the background, never blocks or fails boot, one warning when Redis
 * doesn't answer within 5 s. `upsertJobScheduler` is idempotent across API processes.
 */
@Injectable()
export class ModerationJobSchedulers implements OnApplicationBootstrap {
  private readonly logger = new Logger('ModerationJobSchedulers');
  /** Settles when registration finished or gave up waiting (tests await it). */
  ready: Promise<void> = Promise.resolve();

  constructor(
    @InjectQueue(QUEUE_NAMES.commentModeration)
    private readonly queue: Pick<Queue, 'upsertJobScheduler'>,
  ) {}

  onApplicationBootstrap(): void {
    this.ready = this.register();
  }

  async register(timeoutMs = MODERATION_SCHEDULER_TIMEOUT_MS): Promise<void> {
    const work = this.queue.upsertJobScheduler(
      MODERATION_SWEEP_SCHEDULER_ID,
      { pattern: MODERATION_SWEEP_PATTERN, tz: SCHEDULE_TIME_ZONE },
      {
        name: MODERATION_SWEEP_JOB_NAME,
        data: {},
        opts: { ...MODERATION_SWEEP_JOB_OPTIONS },
      },
    );
    try {
      await withTimeout(work, timeoutMs);
      this.logger.log(
        `Job scheduler registered: ${MODERATION_SWEEP_SCHEDULER_ID}`,
      );
    } catch (error) {
      const reason =
        error instanceof Error && error.message === 'timeout'
          ? `Redis did not answer within ${timeoutMs} ms; still trying in the background`
          : error instanceof Error
            ? error.message
            : 'unknown error';
      this.logger.warn(`Job scheduler not registered yet (${reason})`);
      work.then(
        () =>
          this.logger.log(
            `Job scheduler registered late: ${MODERATION_SWEEP_SCHEDULER_ID}`,
          ),
        () => undefined,
      );
    }
  }
}
