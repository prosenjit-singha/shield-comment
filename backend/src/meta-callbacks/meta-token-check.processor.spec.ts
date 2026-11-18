import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import type { MetaDataDeletionService } from './meta-data-deletion.service.js';
import {
  META_DATA_DELETION_JOB_NAME,
  metaDataDeletionJobId,
  parseMetaDataDeletionJob,
} from './meta-data-deletion.job.js';
import {
  MetaTokenCheckProcessor,
  type MetaTokenCheckResult,
} from './meta-token-check.processor.js';

type Execute = MetaDataDeletionService['execute'];
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

describe('MetaTokenCheckProcessor', () => {
  const execute = vi.fn<Execute>();
  const processor = new MetaTokenCheckProcessor({
    execute,
  } as unknown as MetaDataDeletionService);
  let logs: string[];

  beforeEach(() => {
    execute.mockReset();
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
    } as const;
    execute.mockResolvedValue(outcome);
    expect(await processor.process(job())).toEqual(outcome);
    expect(execute).toHaveBeenCalledWith(REQUEST_ID);
    expect(logs.join('\n')).toContain(
      `Data deletion ${REQUEST_ID} completed: 1 connection(s), 2 page(s), 5 comment(s), 6 webhook event(s)`,
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
      processor.process(job({ name: 'debug-token' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(execute).not.toHaveBeenCalled();
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
