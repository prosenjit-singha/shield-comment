import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  errorCode,
  isPermanentDbError,
} from '../comments/comment-ingest.rules.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  AlertDispatchService,
  type ScamSpikeOutcome,
} from './alert-dispatch.service.js';
import { parseScamSpikeJob, SCAM_SPIKE_JOB_NAME } from './scam-spike.js';

const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The `alerts` worker (M7-T9; D3 defaults: 5 attempts, exponential 2 s). `scam-spike` →
 * `AlertDispatchService.dispatchSpike()`. Retries never re-send a target that already got the
 * alert (`job.data.sent`, saved with `job.updateData`; emails also carry a Resend idempotency
 * key per job + member). Unknown name / invalid data / permanent DB error → `UnrecoverableError`.
 * E2E: `FakeWorker`; specs call `process(job)`.
 */
@Processor(QUEUE_NAMES.alerts)
export class AlertsProcessor extends WorkerHost {
  private readonly logger = new Logger('AlertsWorker');
  private lastWorkerError: { message: string; at: number } | undefined;

  constructor(private readonly dispatch: AlertDispatchService) {
    super();
  }

  async process(
    job: Job<unknown, ScamSpikeOutcome>,
  ): Promise<ScamSpikeOutcome> {
    if (job.name !== SCAM_SPIKE_JOB_NAME)
      throw new UnrecoverableError('alerts: unknown job name');
    const data = parseScamSpikeJob(job.data);
    if (!data) throw new UnrecoverableError('scam-spike: invalid job data');
    try {
      return await this.dispatch.dispatchSpike(data, job.id ?? 'unknown', {
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
        saveSent: (sent) => job.updateData({ ...data, sent }),
      });
    } catch (error) {
      if (isPermanentDbError(error)) {
        const code = errorCode(error) ?? 'unknown';
        throw new UnrecoverableError(
          `scam-spike: database rejected the change (${code})`,
        );
      }
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    const attempts = job?.opts.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    const final = error.name === 'UnrecoverableError' || made >= attempts;
    const line = `Job ${job?.id ?? '?'} failed (attempt ${made}/${attempts}): ${error.message}`;
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
    )
      return;
    this.lastWorkerError = { message: error.message, at: now };
    this.logger.warn(`Worker ${QUEUE_NAMES.alerts}: ${error.message}`);
  }
}
