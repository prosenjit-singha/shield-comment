import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  fbCommentValue,
  fbPayload,
  igPayload,
} from '../../test/fixtures/meta-webhook-payloads.js';
import { DEFAULT_JOB_OPTIONS } from '../queue/queue.constants.js';
import {
  COMMENT_INGEST_JOB_NAME,
  type CommentIngestJobData,
} from './comment-ingest.job.js';
import {
  MetaWebhookReceiver,
  WEBHOOK_ENQUEUE_TIMEOUT_MS,
} from './meta-webhook.receiver.js';

type AddBulk = Queue<CommentIngestJobData>['addBulk'];

const body = (payload: unknown) => Buffer.from(JSON.stringify(payload));

describe('MetaWebhookReceiver', () => {
  let addBulk: ReturnType<typeof vi.fn<AddBulk>>;
  let receiver: MetaWebhookReceiver;
  let logs: string[];

  beforeEach(() => {
    addBulk = vi.fn<AddBulk>().mockResolvedValue([]);
    receiver = new MetaWebhookReceiver({
      addBulk,
    } as unknown as Queue<CommentIngestJobData>);
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message) => {
        logs.push(String(message));
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('adds every kept change in one addBulk with the job id + D3 options', async () => {
    const payload = {
      object: 'page',
      entry: [
        ...(fbPayload().entry as unknown[]),
        ...(fbPayload(
          fbCommentValue({ comment_id: '3000000000001_4000000000002' }),
        ).entry as unknown[]),
      ],
    };
    const receipt = await receiver.receive(body(payload));
    expect(receipt).toEqual({ enqueued: 2, skipped: {} });
    expect(addBulk).toHaveBeenCalledTimes(1);
    const jobs = addBulk.mock.calls[0]![0];
    expect(jobs.map((job) => job.opts?.jobId)).toEqual([
      'FACEBOOK:3000000000001_4000000000001:add',
      'FACEBOOK:3000000000001_4000000000002:add',
    ]);
    for (const job of jobs) {
      expect(job.name).toBe(COMMENT_INGEST_JOB_NAME);
      expect(job.opts).toMatchObject(DEFAULT_JOB_OPTIONS);
      expect(job.data.eventId).toBe(job.opts?.jobId);
    }
  });

  it('enqueues IG comments too', async () => {
    await receiver.receive(body(igPayload()));
    expect(addBulk.mock.calls[0]![0][0]!.data).toMatchObject({
      platform: 'INSTAGRAM',
      verb: 'add',
    });
  });

  it('does not touch the queue when nothing is kept', async () => {
    const receipt = await receiver.receive(
      body(fbPayload(fbCommentValue({ item: 'status' }))),
    );
    expect(receipt).toEqual({ enqueued: 0, skipped: { unknown_item: 1 } });
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('accepts invalid JSON with a warning and nothing enqueued', async () => {
    const receipt = await receiver.receive(Buffer.from('a=1&b=2'));
    expect(receipt).toEqual({ enqueued: 0, skipped: { invalid_json: 1 } });
    expect(addBulk).not.toHaveBeenCalled();
    expect(logs).toContain('Meta webhook body is not valid JSON; ignored');
  });

  it('503 when the queue rejects', async () => {
    addBulk.mockRejectedValue(new Error('Connection is closed.'));
    await expect(receiver.receive(body(fbPayload()))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(logs.some((line) => line.includes('Connection is closed.'))).toBe(
      true,
    );
  });

  it(`503 when the queue does not answer within ${WEBHOOK_ENQUEUE_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers();
    addBulk.mockReturnValue(new Promise<never>(() => {}));
    const pending = receiver.receive(body(fbPayload()));
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await vi.advanceTimersByTimeAsync(WEBHOOK_ENQUEUE_TIMEOUT_MS);
    await assertion;
  });

  it('logs counts only: never the comment text or author name', async () => {
    await receiver.receive(
      body({
        object: 'page',
        entry: [
          ...(fbPayload().entry as unknown[]),
          ...(fbPayload(fbCommentValue({ verb: 'hide' })).entry as unknown[]),
        ],
      }),
    );
    expect(logs).toEqual([
      'Meta webhook enqueued 1 (object=page kept=1 skipped=unknown_verb:1)',
    ]);
    addBulk.mockRejectedValue(new Error('timeout'));
    await receiver.receive(body(fbPayload())).catch(() => undefined);
    const joined = logs.join('\n');
    expect(joined).not.toContain('bKash');
    expect(joined).not.toContain('Rahim');
  });
});
