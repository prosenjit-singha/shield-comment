import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { fbPayload } from '../../test/fixtures/meta-webhook-payloads.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  COMMENT_INGEST_JOB_NAME,
  type CommentIngestJobData,
} from '../webhooks/comment-ingest.job.js';
import { parseMetaWebhookEnvelope } from '../webhooks/meta-webhook-envelope.js';
import { CommentIngestProcessor } from './comment-ingest.processor.js';
import type {
  CommentIngestService,
  IngestOutcome,
} from './comment-ingest.service.js';

type Ingest = CommentIngestService['ingest'];

const data = (): CommentIngestJobData =>
  parseMetaWebhookEnvelope(JSON.stringify(fbPayload())).jobs[0]!.data;

const job = (overrides: Partial<Job> = {}) =>
  ({
    id: 'FACEBOOK:3000000000001_4000000000001:add',
    name: COMMENT_INGEST_JOB_NAME,
    data: data(),
    opts: { attempts: 5 },
    attemptsMade: 0,
    ...overrides,
  }) as unknown as Job<unknown, IngestOutcome>;

const pgError = (code: string) =>
  Object.assign(new Error('Failed query … params: bKash 017 Rahim'), {
    cause: Object.assign(new Error('x'), { code }),
  });

describe('CommentIngestProcessor', () => {
  const ingest = vi.fn<Ingest>();
  const processor = new CommentIngestProcessor({
    ingest,
  } as unknown as CommentIngestService);
  let logs: string[];

  beforeEach(() => {
    ingest.mockReset();
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message) => {
        logs.push(`${level}: ${String(message)}`);
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  const allLogs = () => logs.join('\n');

  it('is the comment-ingest processor', () => {
    expect(
      Reflect.getMetadata('bullmq:processor_metadata', CommentIngestProcessor),
    ).toMatchObject({ name: QUEUE_NAMES.commentIngest });
  });

  it('passes validated data to the service and returns its outcome', async () => {
    const outcome: IngestOutcome = {
      kind: 'stored',
      workspaceId: 'ws',
      action: 'created',
      commentRowId: 'c1',
      moderate: true,
    };
    ingest.mockResolvedValue(outcome);
    await expect(processor.process(job())).resolves.toBe(outcome);
    expect(ingest).toHaveBeenCalledWith(data());
  });

  it('logs a drop with ids and the reason only, and completes', async () => {
    ingest.mockResolvedValue({ kind: 'dropped', reason: 'unknown_page' });
    await expect(processor.process(job())).resolves.toEqual({
      kind: 'dropped',
      reason: 'unknown_page',
    });
    expect(logs).toEqual([
      'log: Dropped FACEBOOK:3000000000001_4000000000001:add: unknown_page (FACEBOOK 1000000000001)',
    ]);
  });

  it('completes duplicates quietly (debug only)', async () => {
    ingest.mockResolvedValue({ kind: 'duplicate', workspaceId: 'ws' });
    await processor.process(job());
    expect(logs.every((line) => line.startsWith('debug:'))).toBe(true);
  });

  it('invalid job → UnrecoverableError without touching the DB', async () => {
    await expect(
      processor.process(job({ data: { ...data(), verb: 'hide' } })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processor.process(job({ name: 'other' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(ingest).not.toHaveBeenCalled();
  });

  it.each(['23514', '23502', '22001'])(
    'permanent DB error %s → UnrecoverableError, no comment text logged',
    async (code) => {
      ingest.mockRejectedValue(pgError(code));
      const error = await processor.process(job()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toContain(code);
      expect(allLogs()).toContain(code);
      expect(allLogs()).not.toMatch(/bKash|Rahim/);
    },
  );

  it.each([
    ['connection lost', Object.assign(new Error('x'), { code: 'ECONNRESET' })],
    ['deadlock', pgError('40P01')],
    ['FK race', pgError('23503')],
    ['plain error', new Error('boom')],
  ])('retryable error (%s) is rethrown as is', async (_l, error) => {
    ingest.mockRejectedValue(error);
    await expect(processor.process(job())).rejects.toBe(error);
  });

  it('failed event: warn while retries remain, error on the last attempt, no DB text', () => {
    processor.onFailed(job({ attemptsMade: 2 }), pgError('40P01'));
    processor.onFailed(job({ attemptsMade: 5 }), pgError('40P01'));
    processor.onFailed(
      job({ attemptsMade: 1 }),
      new UnrecoverableError(
        'comment-ingest: database rejected the change (23514)',
      ),
    );
    processor.onFailed(undefined, new Error('x'));
    expect(logs[0]).toMatch(
      /^warn: Job .* failed \(attempt 2\/5\): Error 40P01$/,
    );
    expect(logs[1]).toMatch(/^error: .*attempt 5\/5/);
    expect(logs[2]).toMatch(/^error: .*\(23514\)$/);
    expect(logs[3]).toMatch(/^warn: Job \? failed/);
    expect(allLogs()).not.toMatch(/bKash|Rahim/);
  });

  it('worker errors are logged once per message per 5 minutes', () => {
    vi.useFakeTimers({ now: new Date('2026-11-18T00:00:00Z') });
    try {
      processor.onError(new Error('ECONNREFUSED'));
      processor.onError(new Error('ECONNREFUSED'));
      processor.onError(new Error('other'));
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      processor.onError(new Error('other'));
      expect(logs.filter((l) => l.startsWith('warn:'))).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
