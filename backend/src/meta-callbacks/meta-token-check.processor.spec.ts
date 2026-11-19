import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import type {
  RawPayloadPurgeOutcome,
  RawPayloadPurgeService,
} from '../comments/raw-payload-purge.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import type { MetaDataDeletionService } from './meta-data-deletion.service.js';
import {
  META_DATA_DELETION_JOB_NAME,
  metaDataDeletionJobId,
  parseMetaDataDeletionJob,
} from './meta-data-deletion.job.js';
import {
  isScheduledJobData,
  META_DEBUG_TOKEN_JOB_NAME,
  META_SCHEDULED_JOBS,
  RAW_PAYLOAD_PURGE_JOB_NAME,
  SCHEDULE_TIME_ZONE,
} from './meta-scheduled.jobs.js';
import {
  MetaTokenCheckProcessor,
  type MetaTokenCheckResult,
} from './meta-token-check.processor.js';
import type {
  MetaTokenCheckService,
  TokenCheckOutcome,
} from './meta-token-check.service.js';

type Execute = MetaDataDeletionService['execute'];
type RunTokenCheck = MetaTokenCheckService['run'];
type RunPurge = RawPayloadPurgeService['run'];
const REQUEST_ID = '0195a1b2-0000-7000-8000-000000000001';

const job = (overrides: Partial<Job> = {}) =>
  ({
    id: metaDataDeletionJobId(REQUEST_ID),
    name: META_DATA_DELETION_JOB_NAME,
    data: { requestId: REQUEST_ID },
    opts: { attempts: 5 },
    attemptsMade: 0,
    ...overrides,
  }) as unknown as Job<unknown, MetaTokenCheckResult>;

const pgError = (code: string) =>
  Object.assign(new Error('Failed query … params: 10000000000001'), {
    cause: Object.assign(new Error('x'), { code }),
  });

describe('meta data deletion job contract', () => {
  it('job id per request, no colons (BullMQ custom id rule)', () => {
    expect(metaDataDeletionJobId(REQUEST_ID)).toBe(
      `data-deletion-${REQUEST_ID}`,
    );
  });

  it.each([
    [null],
    ['x'],
    [{}],
    [{ requestId: 'not-a-uuid' }],
    [{ requestId: 42 }],
  ])('rejects %j', (data) => {
    expect(parseMetaDataDeletionJob(data)).toBeNull();
  });

  it('accepts a uuid', () => {
    expect(parseMetaDataDeletionJob({ requestId: REQUEST_ID })).toEqual({
      requestId: REQUEST_ID,
    });
  });
});

describe('scheduled job contract', () => {
  it('debug-token daily 03:00 and purge daily 03:30, Asia/Dhaka, stable ids', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('Asia/Dhaka');
    expect(META_SCHEDULED_JOBS).toEqual([
      {
        schedulerId: 'meta-debug-token-daily',
        name: META_DEBUG_TOKEN_JOB_NAME,
        pattern: '0 3 * * *',
      },
      {
        schedulerId: 'raw-payload-purge-daily',
        name: RAW_PAYLOAD_PURGE_JOB_NAME,
        pattern: '30 3 * * *',
      },
    ]);
  });

  it.each([
    [undefined, true],
    [null, true],
    [{}, true],
    [[], false],
    ['x', false],
    [1, false],
  ])('data %j accepted: %s', (data, ok) => {
    expect(isScheduledJobData(data)).toBe(ok);
  });
});

describe('MetaTokenCheckProcessor', () => {
  const execute = vi.fn<Execute>();
  const runTokenCheck = vi.fn<RunTokenCheck>();
  const runPurge = vi.fn<RunPurge>();
  const processor = new MetaTokenCheckProcessor(
    { execute } as unknown as MetaDataDeletionService,
    { run: runTokenCheck } as unknown as MetaTokenCheckService,
    { run: runPurge } as unknown as RawPayloadPurgeService,
  );
  let logs: string[];

  beforeEach(() => {
    execute.mockReset();
    runTokenCheck.mockReset();
    runPurge.mockReset();
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message) => {
        logs.push(`${level}: ${String(message)}`);
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('is the meta-token-check processor', () => {
    expect(
      Reflect.getMetadata('bullmq:processor_metadata', MetaTokenCheckProcessor),
    ).toMatchObject({ name: QUEUE_NAMES.metaTokenCheck });
  });

  it('runs data-deletion jobs and logs counts only', async () => {
    const outcome = {
      kind: 'completed',
      connectionsSeen: 1,
      connections: 1,
      pages: 2,
      comments: 5,
      webhookEvents: 6,
      moderationActions: 3,
    } as const;
    execute.mockResolvedValue(outcome);
    expect(await processor.process(job())).toEqual(outcome);
    expect(execute).toHaveBeenCalledWith(REQUEST_ID);
    expect(logs.join('\n')).toContain(
      `Data deletion ${REQUEST_ID} completed: 1 connection(s), 2 page(s), 5 comment(s), 6 webhook event(s), 3 moderation action(s)`,
    );
  });

  it.each([['already_completed'], ['missing']] as const)(
    'passes %s through',
    async (kind) => {
      execute.mockResolvedValue({ kind });
      expect(await processor.process(job())).toEqual({ kind });
    },
  );

  it('unknown job name → UnrecoverableError, no work', async () => {
    await expect(
      processor.process(job({ name: 'debug_token' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(execute).not.toHaveBeenCalled();
    expect(runTokenCheck).not.toHaveBeenCalled();
    expect(runPurge).not.toHaveBeenCalled();
  });

  const scheduled = (name: string, data: unknown = {}) =>
    job({ id: `repeat:${name}:1`, name, data });

  it('debug-token runs the token check and logs counts', async () => {
    const outcome: TokenCheckOutcome = {
      kind: 'token_check',
      rateLimited: true,
      counts: {
        checked: 4,
        unchanged: 1,
        toActive: 1,
        toNeedsReauth: 1,
        expiryRefreshed: 0,
        raced: 0,
        graphErrors: 1,
        undecryptable: 0,
        notChecked: 3,
      },
    };
    runTokenCheck.mockResolvedValue(outcome);
    expect(await processor.process(scheduled(META_DEBUG_TOKEN_JOB_NAME))).toBe(
      outcome,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(runPurge).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain(
      'Token check: 4 checked, 1 unchanged, 1 → ACTIVE, 1 → NEEDS_REAUTH',
    );
    expect(logs.join('\n')).toContain('3 not checked (rate limited)');
  });

  it('debug-token passes a skipped run through', async () => {
    runTokenCheck.mockResolvedValue({
      kind: 'token_check_skipped',
      reason: 'meta_not_configured',
    });
    expect(
      await processor.process(scheduled(META_DEBUG_TOKEN_JOB_NAME)),
    ).toEqual({ kind: 'token_check_skipped', reason: 'meta_not_configured' });
  });

  it('raw-payload-purge runs the purge and logs counts', async () => {
    const outcome: RawPayloadPurgeOutcome = {
      kind: 'raw_payload_purge',
      cutoff: '2026-10-19T00:00:00.000Z',
      purged: 1500,
      batches: 2,
      complete: true,
    };
    runPurge.mockResolvedValue(outcome);
    expect(await processor.process(scheduled(RAW_PAYLOAD_PURGE_JOB_NAME))).toBe(
      outcome,
    );
    expect(runTokenCheck).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain(
      'raw_payload purge: 1500 comment(s) cleared in 2 batch(es)',
    );
  });

  it.each([META_DEBUG_TOKEN_JOB_NAME, RAW_PAYLOAD_PURGE_JOB_NAME])(
    '%s with invalid data → UnrecoverableError, no work',
    async (name) => {
      await expect(
        processor.process(scheduled(name, 'nope')),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(runTokenCheck).not.toHaveBeenCalled();
      expect(runPurge).not.toHaveBeenCalled();
    },
  );

  it('scheduled job: permanent DB error → UnrecoverableError, retryable rethrown', async () => {
    runPurge.mockRejectedValueOnce(pgError('42703'));
    await expect(
      processor.process(scheduled(RAW_PAYLOAD_PURGE_JOB_NAME)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(logs.join('\n')).not.toContain('10000000000001');
    const retryable = pgError('ECONNREFUSED');
    runTokenCheck.mockRejectedValueOnce(retryable);
    await expect(
      processor.process(scheduled(META_DEBUG_TOKEN_JOB_NAME)),
    ).rejects.toBe(retryable);
  });

  it('invalid data → UnrecoverableError, no work', async () => {
    await expect(
      processor.process(job({ data: { requestId: 'x' } })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['22P02', '23502', '23514', '42P01'])(
    'permanent DB error %s → UnrecoverableError without the DB message in logs',
    async (code) => {
      execute.mockRejectedValue(pgError(code));
      await expect(processor.process(job())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(logs.join('\n')).toContain(code);
      expect(logs.join('\n')).not.toContain('10000000000001');
    },
  );

  it.each([['ECONNREFUSED'], ['40P01'], ['23503']])(
    'retryable error %s is rethrown as is',
    async (code) => {
      const error = pgError(code);
      execute.mockRejectedValue(error);
      await expect(processor.process(job())).rejects.toBe(error);
    },
  );

  it('failed event: warn while retries remain, error when final', () => {
    processor.onFailed(
      job({ attemptsMade: 1 }) as Job,
      Object.assign(new Error('boom'), { code: '40P01' }),
    );
    processor.onFailed(
      job({ attemptsMade: 5 }) as Job,
      Object.assign(new Error('boom'), { code: '40P01' }),
    );
    expect(logs[0]).toMatch(/^warn: Job data-deletion .* \(attempt 1\/5\)/);
    expect(logs[1]).toMatch(/^error: Job data-deletion .* \(attempt 5\/5\)/);
    expect(logs.join('\n')).not.toContain('boom');
  });

  it('worker errors are throttled per message', () => {
    processor.onError(new Error('ECONNREFUSED'));
    processor.onError(new Error('ECONNREFUSED'));
    expect(logs).toHaveLength(1);
  });
});
