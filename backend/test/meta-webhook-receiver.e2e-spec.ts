import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { webhookPayloadHash } from '../src/comments/comments.queries.js';
import {
  commentEditHash,
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
} from '../src/queue/queue.constants.js';
import { COMMENT_INGEST_JOB_NAME } from '../src/webhooks/comment-ingest.job.js';
import {
  META_WEBHOOK_CONFIG,
  type MetaWebhookConfig,
} from '../src/webhooks/meta-webhook.config.js';
import { metaWebhookSignature } from '../src/webhooks/meta-webhook-signature.js';
import {
  entry,
  envelope,
  FB_PAGE_ID,
  FB_POST_ID,
  fbCommentValue,
  IG_BUSINESS_ID,
  IG_MEDIA_ID,
  igCommentValue,
  igPayload,
} from './fixtures/meta-webhook-payloads.js';
import { createTestApp } from './utils/create-test-app.js';
import { fakeQueue, type FakeQueue } from './utils/fake-queue.js';

const PATH = '/api/webhooks/meta';
const SECRET = 'e2e-meta-app-secret-0123456789abcdef';

/**
 * M4-T4: signed Meta deliveries → one `comment-ingest` job per kept comment change (D2/D3), 200
 * `EVENT_RECEIVED` in < 200 ms, 503 when the queue fails so Meta retries. No DB work: the queue is
 * the e2e `FakeQueue`, so nothing is written anywhere.
 */
describe('Meta webhook receiver (e2e)', () => {
  let app: INestApplication<App>;
  let queue: FakeQueue;
  const config: MetaWebhookConfig = { verifyToken: null, appSecret: SECRET };

  const post = (payload: unknown, sign = true) => {
    const body =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = request(app.getHttpServer())
      .post(PATH)
      .set('Content-Type', 'application/json')
      .send(body);
    return sign
      ? req.set('X-Hub-Signature-256', metaWebhookSignature(body, SECRET))
      : req;
  };

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(META_WEBHOOK_CONFIG).useValue(config),
    );
    queue = fakeQueue(app, QUEUE_NAMES.commentIngest);
  });

  beforeEach(() => queue.reset());

  afterAll(async () => {
    await app?.close();
  });

  it('FB feed: add + edited + remove in one delivery → exact jobs, 200 in < 200 ms', async () => {
    const add = fbCommentValue();
    const edited = fbCommentValue({ verb: 'edited', message: 'new 01800' });
    const remove = fbCommentValue({ verb: 'remove', message: undefined });
    const payload = envelope('page', [
      entry(FB_PAGE_ID, [
        { field: 'feed', value: add },
        { field: 'feed', value: edited },
        { field: 'feed', value: remove },
      ]),
    ]);

    const started = performance.now();
    const res = await post(payload).expect(200);
    const elapsed = performance.now() - started;

    expect(res.text).toBe('EVENT_RECEIVED');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(elapsed).toBeLessThan(200);

    const commentId = '3000000000001_4000000000001';
    const editedId = `FACEBOOK:${commentId}:edited-${commentEditHash('new 01800')}`;
    expect(queue.jobs.map((job) => job.id)).toEqual([
      `FACEBOOK:${commentId}:add`,
      editedId,
      `FACEBOOK:${commentId}:remove`,
    ]);
    expect(queue.jobs[0]).toEqual({
      id: `FACEBOOK:${commentId}:add`,
      name: COMMENT_INGEST_JOB_NAME,
      opts: { ...DEFAULT_JOB_OPTIONS, jobId: `FACEBOOK:${commentId}:add` },
      data: {
        eventId: `FACEBOOK:${commentId}:add`,
        platform: 'FACEBOOK',
        pageId: FB_PAGE_ID,
        verb: 'add',
        commentId,
        postId: FB_POST_ID,
        parentId: FB_POST_ID,
        authorId: '2000000000001',
        authorName: 'Rahim Uddin',
        message: 'bKash e taka pathan 01700000000',
        createdTime: 1763479990,
        entryTime: 1763480000,
        payloadHash: webhookPayloadHash(add),
        rawPayload: add,
      },
    });
    expect(queue.jobs[1]!.data).toMatchObject({
      eventId: editedId,
      verb: 'edited',
      message: 'new 01800',
    });
    expect(queue.jobs[2]!.data).toMatchObject({
      verb: 'remove',
      message: null,
    });
  });

  it('IG comments → one add job routed by the IG business id', async () => {
    const value = igCommentValue();
    await post(igPayload(value)).expect(200);
    expect(queue.jobs).toEqual([
      {
        id: 'INSTAGRAM:18100000000000001:add',
        name: COMMENT_INGEST_JOB_NAME,
        opts: {
          ...DEFAULT_JOB_OPTIONS,
          jobId: 'INSTAGRAM:18100000000000001:add',
        },
        data: {
          eventId: 'INSTAGRAM:18100000000000001:add',
          platform: 'INSTAGRAM',
          igBusinessId: IG_BUSINESS_ID,
          verb: 'add',
          commentId: '18100000000000001',
          postId: IG_MEDIA_ID,
          parentId: null,
          authorId: '5000000000001',
          authorName: 'karim.shop',
          message: 'Nagad e order korun',
          createdTime: null,
          entryTime: 1763480000,
          payloadHash: webhookPayloadHash(value),
          rawPayload: value,
        },
      },
    ]);
  });

  it('the same delivery twice still leaves one job per id', async () => {
    const payload = igPayload();
    await post(payload).expect(200);
    await post(payload).expect(200);
    expect(queue.jobs.map((job) => job.id)).toEqual([
      'INSTAGRAM:18100000000000001:add',
    ]);
  });

  it('a second, different edit of one comment is a new job', async () => {
    const edit = (message: string) =>
      envelope('page', [
        entry(FB_PAGE_ID, [
          { field: 'feed', value: fbCommentValue({ verb: 'edited', message }) },
        ]),
      ]);
    await post(edit('first edit')).expect(200);
    await post(edit('first edit')).expect(200);
    await post(edit('second edit')).expect(200);
    expect(queue.jobs).toHaveLength(2);
  });

  it('skips own comments and unknown fields/items/verbs with 200', async () => {
    const payload = envelope('page', [
      entry(FB_PAGE_ID, [
        {
          field: 'feed',
          value: fbCommentValue({ from: { id: FB_PAGE_ID, name: 'Shop' } }),
        },
        { field: 'feed', value: fbCommentValue({ item: 'reaction' }) },
        { field: 'feed', value: fbCommentValue({ verb: 'hide' }) },
        { field: 'mention', value: fbCommentValue() },
      ]),
    ]);
    const res = await post(payload).expect(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(queue.jobs).toEqual([]);
  });

  it('unknown object → 200 and nothing enqueued', async () => {
    await post({ object: 'user', entry: [] }).expect(200);
    await post(
      envelope('instagram', [
        entry(IG_BUSINESS_ID, [
          { field: 'live_comments', value: igCommentValue() },
        ]),
      ]),
    ).expect(200);
    expect(queue.jobs).toEqual([]);
  });

  it('signed invalid JSON → 200 and nothing enqueued', async () => {
    const res = await post('{"object":"page","entry":[').expect(200);
    expect(res.text).toBe('EVENT_RECEIVED');
    expect(queue.jobs).toEqual([]);
  });

  it('unsigned → 401 and nothing enqueued', async () => {
    const res = await post(igPayload(), false).expect(401);
    expect(res.body).toMatchObject({ statusCode: 401 });
    expect(queue.jobs).toEqual([]);
  });

  it('503 with the error shape when the queue rejects; the retry then succeeds', async () => {
    queue.failAdds(new Error('Connection is closed.'));
    const res = await post(igPayload()).expect(503);
    expect(res.body).toMatchObject({
      statusCode: 503,
      message: 'Webhook queue unavailable',
      path: PATH,
    });
    expect(queue.jobs).toEqual([]);

    queue.failAdds(null);
    await post(igPayload()).expect(200);
    expect(queue.jobs).toHaveLength(1);
  });

  it('503 within the 200 ms budget when the queue hangs (Redis down)', async () => {
    queue.failAdds('hang');
    const started = performance.now();
    await post(igPayload()).expect(503);
    expect(performance.now() - started).toBeLessThan(200);
    expect(queue.jobs).toEqual([]);
  });
});
