import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { type Job, UnrecoverableError } from 'bullmq';
import type { ScamSpikeDetector } from '../alerts/scam-spike.detector.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  MODERATE_COMMENT_JOB_NAME,
  MODERATION_SWEEP_JOB_NAME,
} from './comment-moderation.job.js';
import { CommentModerationProcessor } from './comment-moderation.processor.js';
import {
  type CommentModerationService,
  type ModerationResult,
  ModerationStepError,
} from './comment-moderation.service.js';
import type { ModerationSweeper } from './comment-moderation.sweeper.js';

const WS = '0190f000-0000-7000-8000-000000000001';
const ROW = '0190f000-0000-7000-8000-0000000000c1';

const job = (overrides: Partial<Job> = {}) =>
  ({
    id: `moderate:${ROW}:add`,
    name: MODERATE_COMMENT_JOB_NAME,
    data: { workspaceId: WS, commentRowId: ROW, editedAt: null },
    opts: { attempts: 5 },
    attemptsMade: 0,
    ...overrides,
  }) as unknown as Job;

const pgError = (code: string) =>
  Object.assign(new Error('Failed query … params: bKash 017'), {
    cause: Object.assign(new Error('x'), { code }),
  });

describe('CommentModerationProcessor', () => {
  const moderate = vi.fn<CommentModerationService['moderate']>();
  const sweep = vi.fn<ModerationSweeper['sweep']>();
  const afterModeration = vi.fn<ScamSpikeDetector['afterModeration']>();
  const env: Partial<EnvironmentVariables> = {
    MODERATION_WORKER_CONCURRENCY: 6,
    MODERATION_LLM_RATE_MAX: 12,
    MODERATION_LLM_RATE_DURATION_MS: 1500,
  };
  const config = {
    get: (key: keyof EnvironmentVariables) => env[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  const processor = new CommentModerationProcessor(
    { moderate } as unknown as CommentModerationService,
    { sweep } as unknown as ModerationSweeper,
    config,
    { afterModeration } as unknown as ScamSpikeDetector,
  );
  let logs: string[];

  beforeEach(() => {
    moderate.mockReset();
    sweep.mockReset();
    afterModeration.mockReset().mockResolvedValue('not_scam');
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message) => {
        logs.push(`${level}: ${String(message)}`);
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('is the comment-moderation processor, built without autorun', () => {
    expect(
      Reflect.getMetadata(
        'bullmq:processor_metadata',
        CommentModerationProcessor,
      ),
    ).toMatchObject({ name: QUEUE_NAMES.commentModeration });
    expect(
      Reflect.getMetadata('bullmq:worker_metadata', CommentModerationProcessor),
    ).toMatchObject({ autorun: false });
  });

  it('bootstrap applies the env concurrency + limiter and starts the worker', () => {
    const worker = {
      concurrency: 1,
      opts: {} as Record<string, unknown>,
      running: false,
      isRunning() {
        return this.running;
      },
      run: vi.fn(function (this: { running: boolean }) {
        this.running = true;
        return Promise.resolve();
      }),
    };
    (processor as unknown as { _worker: unknown })._worker = worker;
    processor.onApplicationBootstrap();
    expect(worker.concurrency).toBe(6);
    expect(worker.opts.limiter).toEqual({ max: 12, duration: 1500 });
    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it('moderate-comment → service with the parsed target + attempt info', async () => {
    const result: ModerationResult = {
      kind: 'skipped',
      reason: 'already_moderated',
    };
    moderate.mockResolvedValue(result);
    await expect(processor.process(job())).resolves.toBe(result);
    expect(moderate).toHaveBeenCalledWith(
      { workspaceId: WS, commentRowId: ROW, editedAt: null },
      { finalAttempt: false },
    );
    await processor.process(job({ attemptsMade: 4 }));
    expect(moderate).toHaveBeenLastCalledWith(expect.anything(), {
      finalAttempt: true,
    });
  });

  it('M7-T9: a moderated outcome runs the spike check after it is saved; skips and failures do not', async () => {
    const moderated: ModerationResult = {
      kind: 'moderated',
      classified: true,
      counted: true,
      action: 'HIDE',
      status: 'HIDDEN',
      replied: false,
    };
    moderate.mockResolvedValueOnce(moderated);
    await expect(processor.process(job())).resolves.toBe(moderated);
    expect(afterModeration).toHaveBeenCalledWith(WS, ROW);

    afterModeration.mockClear();
    moderate.mockResolvedValueOnce({ kind: 'skipped', reason: 'no_text' });
    await processor.process(job());
    moderate.mockRejectedValueOnce(
      new ModerationStepError('classify', 'transient', true),
    );
    await expect(processor.process(job())).rejects.toThrow();
    expect(afterModeration).not.toHaveBeenCalled();
  });

  it('moderation-sweep → sweeper', async () => {
    sweep.mockResolvedValue({ candidates: 2, requeued: 1, queued: 1 });
    await expect(
      processor.process(job({ name: MODERATION_SWEEP_JOB_NAME, data: {} })),
    ).resolves.toEqual({ candidates: 2, requeued: 1, queued: 1 });
    expect(moderate).not.toHaveBeenCalled();
  });

  it('invalid data / unknown name → UnrecoverableError, service untouched', async () => {
    await expect(
      processor.process(job({ data: { workspaceId: WS } })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processor.process(job({ name: 'other' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(moderate).not.toHaveBeenCalled();
  });

  it('retryable step failure (D2 transient) is rethrown → BullMQ retries', async () => {
    const error = new ModerationStepError('classify', 'transient', true);
    moderate.mockRejectedValue(error);
    await expect(processor.process(job())).rejects.toBe(error);
  });

  it.each(['not_configured', 'payment_required', 'auth', 'invalid_output'])(
    'non-retryable step failure %s → UnrecoverableError (D2: not retried)',
    async (kind) => {
      moderate.mockRejectedValue(
        new ModerationStepError('classify', kind, false),
      );
      const error = await processor.process(job()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toContain(kind);
    },
  );

  it('permanent DB error → UnrecoverableError, no comment text logged; others rethrown', async () => {
    moderate.mockRejectedValue(pgError('23514'));
    await expect(processor.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(logs.join('\n')).toContain('23514');
    expect(logs.join('\n')).not.toContain('bKash');
    const deadlock = pgError('40P01');
    moderate.mockRejectedValue(deadlock);
    await expect(processor.process(job())).rejects.toBe(deadlock);
  });

  it('failed event: warn while retries remain, error when final; no DB text', () => {
    processor.onFailed(job({ attemptsMade: 2 }), pgError('40P01'));
    processor.onFailed(
      job({ attemptsMade: 5 }),
      new ModerationStepError('classify', 'timeout', true),
    );
    processor.onFailed(
      job({ attemptsMade: 1 }),
      new UnrecoverableError('comment-moderation: classify failed (auth)'),
    );
    expect(logs[0]).toMatch(/^warn: .*attempt 2\/5\): Error 40P01$/);
    expect(logs[1]).toMatch(
      /^error: .*attempt 5\/5\): comment-moderation: classify failed \(timeout\)$/,
    );
    expect(logs[2]).toMatch(/^error: .*classify failed \(auth\)$/);
    expect(logs.join('\n')).not.toContain('bKash');
  });

  it('worker errors are throttled (one line per message per 5 min)', () => {
    processor.onError(new Error('ECONNREFUSED'));
    processor.onError(new Error('ECONNREFUSED'));
    expect(logs).toEqual(['warn: Worker comment-moderation: ECONNREFUSED']);
  });
});
