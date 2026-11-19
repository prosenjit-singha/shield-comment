import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  describeIngestError,
  errorCode,
  isPermanentDbError,
} from '../comments/comment-ingest.rules.js';
import {
  type RawPayloadPurgeOutcome,
  RawPayloadPurgeService,
} from '../comments/raw-payload-purge.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  type DataDeletionOutcome,
  MetaDataDeletionService,
} from './meta-data-deletion.service.js';
import {
  META_DATA_DELETION_JOB_NAME,
  parseMetaDataDeletionJob,
} from './meta-data-deletion.job.js';
import {
  isScheduledJobData,
  META_DEBUG_TOKEN_JOB_NAME,
  RAW_PAYLOAD_PURGE_JOB_NAME,
} from './meta-scheduled.jobs.js';
import {
  MetaTokenCheckService,
  type TokenCheckOutcome,
} from './meta-token-check.service.js';

const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

/** What a `meta-token-check` job returned (one variant per job name). */
export type MetaTokenCheckResult =
  DataDeletionOutcome | TokenCheckOutcome | RawPayloadPurgeOutcome;

/**
 * The one worker of the `meta-token-check` queue (D3; in the API process). BullMQ runs one worker
 * per queue, so jobs are dispatched by name: M4-T6 `data-deletion` (Module 4 D6); M4-T7 the
 * scheduled `debug-token` check (D8) and `raw-payload-purge` (D4). Unknown name / invalid data /
 * permanent DB error → `UnrecoverableError` (no retries); anything else is retried (5 attempts).
 * Logs carry ids, counts and error codes only.
 *
 * E2E never opens a real BullMQ `Worker` (`FakeWorker`); specs call `process(job)`.
 */
@Processor(QUEUE_NAMES.metaTokenCheck)
export class MetaTokenCheckProcessor extends WorkerHost {
  private readonly logger = new Logger('MetaTokenCheck');
  private lastWorkerError: { message: string; at: number } | undefined;

  constructor(
    private readonly dataDeletion: MetaDataDeletionService,
    private readonly tokenCheck: MetaTokenCheckService,
    private readonly purge: RawPayloadPurgeService,
  ) {
    super();
  }

  async process(
    job: Job<unknown, MetaTokenCheckResult>,
  ): Promise<MetaTokenCheckResult> {
    switch (job.name) {
      case META_DATA_DELETION_JOB_NAME:
        return this.runDataDeletion(job);
      case META_DEBUG_TOKEN_JOB_NAME:
        return this.runScheduled(job, () => this.runTokenCheck());
      case RAW_PAYLOAD_PURGE_JOB_NAME:
        return this.runScheduled(job, () => this.runPurge());
      default:
        this.logger.warn(`Job ${job.id ?? '?'} rejected: unknown name`);
        throw new UnrecoverableError(
          `meta-token-check: unknown job name ${JSON.stringify(job.name)}`,
        );
    }
  }

  private async runDataDeletion(job: Job): Promise<DataDeletionOutcome> {
    const data = parseMetaDataDeletionJob(job.data);
    if (!data) {
      this.logger.warn(`Job ${job.id ?? '?'} rejected: invalid data`);
      throw new UnrecoverableError('data-deletion: invalid job data');
    }
    let outcome: DataDeletionOutcome;
    try {
      outcome = await this.dataDeletion.execute(data.requestId);
    } catch (error) {
      if (isPermanentDbError(error)) {
        const code = errorCode(error) ?? 'unknown';
        this.logger.error(
          `Data deletion ${data.requestId} rejected by the database (${code}); not retried`,
        );
        throw new UnrecoverableError(
          `data-deletion: database rejected the change (${code})`,
        );
      }
      throw error;
    }
    switch (outcome.kind) {
      case 'completed':
        this.logger.log(
          `Data deletion ${data.requestId} completed: ${outcome.connections} connection(s), ${outcome.pages} page(s), ${outcome.comments} comment(s), ${outcome.webhookEvents} webhook event(s), ${outcome.moderationActions} moderation action(s)`,
        );
        break;
      case 'already_completed':
        this.logger.debug(`Data deletion ${data.requestId} already completed`);
        break;
      case 'missing':
        this.logger.warn(`Data deletion ${data.requestId}: request not found`);
        break;
    }
    return outcome;
  }

  /** Shared guard of the scheduled jobs: data must be empty; permanent DB errors aren't retried. */
  private async runScheduled<T>(job: Job, work: () => Promise<T>): Promise<T> {
    if (!isScheduledJobData(job.data)) {
      this.logger.warn(`Job ${job.id ?? '?'} rejected: invalid data`);
      throw new UnrecoverableError(`${job.name}: invalid job data`);
    }
    try {
      return await work();
    } catch (error) {
      if (isPermanentDbError(error)) {
        const code = errorCode(error) ?? 'unknown';
        this.logger.error(
          `${job.name} rejected by the database (${code}); not retried`,
        );
        throw new UnrecoverableError(
          `${job.name}: database rejected the change (${code})`,
        );
      }
      throw error;
    }
  }

  private async runTokenCheck(): Promise<TokenCheckOutcome> {
    const outcome = await this.tokenCheck.run();
    if (outcome.kind === 'token_check') {
      const c = outcome.counts;
      this.logger.log(
        `Token check: ${c.checked} checked, ${c.unchanged} unchanged, ${c.toActive} → ACTIVE, ${c.toNeedsReauth} → NEEDS_REAUTH, ${c.expiryRefreshed} expiry refreshed, ${c.raced} raced, ${c.graphErrors} Graph error(s), ${c.undecryptable} undecryptable, ${c.notChecked} not checked${outcome.rateLimited ? ' (rate limited)' : ''}`,
      );
    }
    return outcome;
  }

  private async runPurge(): Promise<RawPayloadPurgeOutcome> {
    const outcome = await this.purge.run();
    this.logger.log(
      `raw_payload purge: ${outcome.purged} comment(s) cleared in ${outcome.batches} batch(es), cutoff ${outcome.cutoff}${outcome.complete ? '' : ' (batch cap reached, rest next run)'}`,
    );
    return outcome;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    const attempts = job?.opts.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    const final = error.name === 'UnrecoverableError' || made >= attempts;
    const line = `Job ${job?.name ?? '?'} ${job?.id ?? '?'} failed (attempt ${made}/${attempts}): ${
      error.name === 'UnrecoverableError'
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
    this.logger.warn(`Worker ${QUEUE_NAMES.metaTokenCheck}: ${error.message}`);
  }
}
