import type { INestApplication } from '@nestjs/common';
import type { Job } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  comments,
  dailyCommentStats,
  metaConnections,
  metaDataDeletionRequests,
  moderationActions,
  moderationPolicies,
  socialPages,
  webhookEvents,
} from '../src/db/schema/index.js';
import {
  META_CALLBACKS_CONFIG,
  type MetaCallbacksConfig,
} from '../src/meta-callbacks/meta-callbacks.config.js';
import { META_CALLBACK_THROTTLE } from '../src/meta-callbacks/meta-callbacks.module.js';
import {
  META_DATA_DELETION_JOB_NAME,
  metaDataDeletionJobId,
} from '../src/meta-callbacks/meta-data-deletion.job.js';
import { signMetaSignedRequest } from '../src/meta-callbacks/meta-signed-request.js';
import {
  MetaTokenCheckProcessor,
  type MetaTokenCheckResult,
} from '../src/meta-callbacks/meta-token-check.processor.js';
import { QUEUE_NAMES } from '../src/queue/queue.constants.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { type FakeJob, fakeQueue, type FakeQueue } from './utils/fake-queue.js';
import { FakeWorker } from './utils/fake-worker.js';

const SECRET = 'e2e-meta-app-secret-0123456789abcdef';
const CLIENT = 'http://app.localhost:5174';
const TOKEN = 'v1:e2e:iv:tag:ct';

/** A form post like Meta's: `signed_request=<sig>.<payload>`. */
const signed = (userId: unknown, secret = SECRET, extra = {}) =>
  signMetaSignedRequest(
    {
      algorithm: 'HMAC-SHA256',
      issued_at: Math.floor(Date.now() / 1000),
      user_id: userId,
      ...extra,
    },
    secret,
  );

/**
 * M4-T6: Meta Deauthorize + Data Deletion callbacks (Module 4 D6) against the real test DB.
 * Deletion jobs land on the `meta-token-check` FakeQueue; the spec runs them through the real
 * processor (`FakeWorker`, no Redis).
 */
describe('Meta Deauthorize + Data Deletion callbacks (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let queue: FakeQueue;
  let processor: MetaTokenCheckProcessor;
  const config: MetaCallbacksConfig = {
    appSecret: SECRET,
    clientAppUrl: CLIENT,
  };
  let a: Actor; // FB user U (deauthorize)
  let b: Actor; // FB user U too: one FB user, two workspaces
  let c: Actor; // FB user V: must stay untouched
  let d: Actor; // FB user W (data deletion)

  const base = `8${Date.now()}`;
  const U = `${base}01`;
  const V = `${base}02`;
  const W = `${base}03`;
  const UNKNOWN = `${base}09`;
  const PAGE = (n: number) => `${base}1${n}`;
  const comment = (n: number) => `${base}5${n}_${base}6${n}`;
  const db = () => actors.db;
  const http = () => actors.http();

  const post = (path: string, signedRequest: unknown) =>
    http()
      .post(`/api/meta/${path}`)
      .type('form')
      .send(
        // `undefined` → field left out.
        signedRequest === undefined ? {} : { signed_request: signedRequest },
      );

  const connection = (workspaceId: string) =>
    db()
      .select()
      .from(metaConnections)
      .where(eq(metaConnections.workspaceId, workspaceId))
      .then((rows) => rows[0]);
  const pages = (workspaceId: string) =>
    db()
      .select()
      .from(socialPages)
      .where(eq(socialPages.workspaceId, workspaceId));
  const commentRows = (workspaceId: string) =>
    db().select().from(comments).where(eq(comments.workspaceId, workspaceId));
  const eventRows = (workspaceId: string) =>
    db()
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.workspaceId, workspaceId));
  const actionRows = (workspaceId: string) =>
    db()
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.workspaceId, workspaceId));
  const policyRows = (workspaceId: string) =>
    db()
      .select()
      .from(moderationPolicies)
      .where(eq(moderationPolicies.workspaceId, workspaceId));
  const statRows = (workspaceId: string) =>
    db()
      .select()
      .from(dailyCommentStats)
      .where(eq(dailyCommentStats.workspaceId, workspaceId));
  const requestRows = (facebookUserId: string) =>
    db()
      .select()
      .from(metaDataDeletionRequests)
      .where(eq(metaDataDeletionRequests.facebookUserId, facebookUserId));

  const run = (job: FakeJob) =>
    processor.process(job as unknown as Job<unknown, MetaTokenCheckResult>);

  /** Connection + Pages (+ comments, events, stats) for one workspace. */
  async function seed(
    actor: Actor,
    fbUser: string,
    pageNumbers: number[],
    withComments = false,
  ) {
    await db()
      .insert(metaConnections)
      .values({
        workspaceId: actor.workspaceId,
        facebookUserId: fbUser,
        encryptedUserAccessToken: TOKEN,
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
      });
    const rows = await db()
      .insert(socialPages)
      .values(
        pageNumbers.map((n) => ({
          workspaceId: actor.workspaceId,
          pageId: PAGE(n),
          pageName: `Shop ${n}`,
          encryptedPageAccessToken: TOKEN,
          isActive: true,
        })),
      )
      .returning();
    if (!withComments) return;
    await db().insert(moderationPolicies).values({
      workspaceId: actor.workspaceId,
    });
    for (const [i, page] of rows.entries()) {
      const commentId = comment(pageNumbers[i]!);
      const [commentRow] = await db()
        .insert(comments)
        .values({
          commentId,
          workspaceId: actor.workspaceId,
          socialPageId: page.id,
          platform: 'FACEBOOK',
          postId: `${page.pageId}_1`,
          authorId: '42',
          authorName: 'Rahim',
          message: 'bKash 017',
          rawPayload: { message: 'bKash 017' },
        })
        .returning();
      // M5-T7: a hide the AI did (FK restrict → Data Deletion removes it first).
      await db().insert(moderationActions).values({
        workspaceId: actor.workspaceId,
        commentId: commentRow!.id,
        action: 'HIDE',
        source: 'AUTO',
        state: 'SUCCEEDED',
        completedAt: new Date(),
      });
      await db()
        .insert(webhookEvents)
        .values({
          eventId: `FACEBOOK:${commentId}:add`,
          workspaceId: actor.workspaceId,
          payloadHash: 'a'.repeat(64),
          processedAt: new Date(),
        });
      await db().insert(dailyCommentStats).values({
        workspaceId: actor.workspaceId,
        pageId: page.pageId,
        platform: 'FACEBOOK',
        day: '2026-11-18',
        receivedCount: 1,
      });
    }
  }

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(META_CALLBACKS_CONFIG).useValue(config),
    );
    actors = createAuthActors(app);
    queue = fakeQueue(app, QUEUE_NAMES.metaTokenCheck);
    processor = app.get(MetaTokenCheckProcessor);
    a = await actors.signUp('m4t6-a');
    b = await actors.signUp('m4t6-b');
    c = await actors.signUp('m4t6-c');
    d = await actors.signUp('m4t6-d');
    for (const id of [U, V, W, UNKNOWN]) actors.trackFacebookUser(id);
    await seed(a, U, [1, 2]);
    await seed(b, U, [3]);
    await seed(c, V, [4], true);
    await seed(d, W, [5, 6], true);
  });

  beforeEach(() => {
    queue.reset();
    config.appSecret = SECRET;
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('runs no real BullMQ worker (FakeWorker on meta-token-check)', () => {
    const worker: unknown = processor.worker;
    expect(worker).toBeInstanceOf(FakeWorker);
    expect((worker as FakeWorker).name).toBe(QUEUE_NAMES.metaTokenCheck);
  });

  describe('POST /api/meta/deauthorize', () => {
    it('503 when META_APP_SECRET is unset', async () => {
      config.appSecret = null;
      await post('deauthorize', signed(U)).expect(503);
      expect((await connection(a.workspaceId))!.status).toBe('ACTIVE');
    });

    it.each([
      ['missing field', undefined, 400],
      ['not a signed_request', 'nope', 400],
      ['signed with another secret', signed(U, 'wrong-secret'), 401],
      ['wrong algorithm', signed(U, SECRET, { algorithm: 'HMAC-SHA1' }), 400],
      ['non-numeric user_id', signed('abc'), 400],
    ])('%s → %i, nothing changes', async (_label, value, status) => {
      const res = await post('deauthorize', value).expect(status);
      expect(JSON.stringify(res.body)).not.toContain(String(value));
      expect((await connection(a.workspaceId))!.status).toBe('ACTIVE');
      expect((await pages(a.workspaceId)).every((p) => p.isActive)).toBe(true);
    });

    it('revokes every connection of the user, switches all their Pages off and clears tokens', async () => {
      const before = await connection(a.workspaceId);
      const res = await post('deauthorize', signed(U)).expect(200);
      expect(res.body).toEqual({ success: true });

      for (const actor of [a, b]) {
        const row = (await connection(actor.workspaceId))!;
        expect(row).toMatchObject({
          facebookUserId: U,
          status: 'REVOKED',
          encryptedUserAccessToken: null,
          tokenExpiresAt: null,
        });
        expect(row.statusChangedAt.getTime()).toBeGreaterThan(
          before!.statusChangedAt.getTime(),
        );
        const rows = await pages(actor.workspaceId);
        expect(rows.length).toBeGreaterThan(0);
        for (const page of rows) {
          expect(page).toMatchObject({
            isActive: false,
            encryptedPageAccessToken: null,
          });
        }
      }
      // Other users' workspaces untouched.
      expect(await connection(c.workspaceId)).toMatchObject({
        status: 'ACTIVE',
        encryptedUserAccessToken: TOKEN,
      });
      expect(await pages(c.workspaceId)).toEqual([
        expect.objectContaining({
          isActive: true,
          encryptedPageAccessToken: TOKEN,
        }),
      ]);
    });

    it('a repeat is a no-op (200, timestamps kept)', async () => {
      const before = (await connection(a.workspaceId))!;
      const pagesBefore = await pages(a.workspaceId);
      await post('deauthorize', signed(U)).expect(200, { success: true });
      const after = (await connection(a.workspaceId))!;
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.statusChangedAt).toEqual(before.statusChangedAt);
      const stamps = (rows: { id: string; updatedAt: Date }[]) =>
        Object.fromEntries(rows.map((p) => [p.id, p.updatedAt.getTime()]));
      expect(stamps(await pages(a.workspaceId))).toEqual(stamps(pagesBefore));
    });

    it('unknown user → 200, nothing written', async () => {
      await post('deauthorize', signed(UNKNOWN)).expect(200, {
        success: true,
      });
    });

    it('re-connect after revoke is allowed by the schema (token back, ACTIVE)', async () => {
      await db()
        .update(metaConnections)
        .set({ status: 'ACTIVE', encryptedUserAccessToken: TOKEN })
        .where(eq(metaConnections.workspaceId, b.workspaceId));
      // …but a non-revoked row without a token is rejected (check constraint).
      await expect(
        db()
          .update(metaConnections)
          .set({ encryptedUserAccessToken: null })
          .where(eq(metaConnections.workspaceId, b.workspaceId)),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });
  });

  describe('POST /api/meta/data-deletion + status + job', () => {
    let code: string;

    it('503 when META_APP_SECRET is unset', async () => {
      config.appSecret = null;
      await post('data-deletion', signed(W)).expect(503);
      expect(await requestRows(W)).toHaveLength(0);
    });

    it('bad signature → 401, no request row, no job', async () => {
      await post('data-deletion', signed(W, 'wrong-secret')).expect(401);
      await post('data-deletion', 'x.y').expect(400);
      expect(await requestRows(W)).toHaveLength(0);
      expect(queue.jobs).toHaveLength(0);
    });

    it('answers { url, confirmation_code } and enqueues one job', async () => {
      const res = await post('data-deletion', signed(W)).expect(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'confirmation_code',
        'url',
      ]);
      code = res.body.confirmation_code as string;
      expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(res.body.url).toBe(`${CLIENT}/data-deletion?code=${code}`);

      const [row, ...rest] = await requestRows(W);
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        confirmationCode: code,
        status: 'PENDING',
        completedAt: null,
      });
      expect(queue.jobs).toEqual([
        expect.objectContaining({
          id: metaDataDeletionJobId(row!.id),
          name: META_DATA_DELETION_JOB_NAME,
          data: { requestId: row!.id },
        }),
      ]);
    });

    it('status lookup: PENDING, no ids', async () => {
      const res = await http()
        .get(`/api/meta/data-deletion/${code}`)
        .expect(200);
      expect(res.body).toEqual({
        status: 'PENDING',
        requestedAt: expect.any(String),
        completedAt: null,
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('a repeat while PENDING reuses the request (same code, one job)', async () => {
      await post('data-deletion', signed(W)).expect(200);
      const res = await post('data-deletion', signed(W)).expect(200);
      expect(res.body.confirmation_code).toBe(code);
      expect(await requestRows(W)).toHaveLength(1);
      expect(queue.jobs).toHaveLength(1);
    });

    it('the job deletes moderation actions → events → comments → Pages → connection, keeps aggregates + policy, completes', async () => {
      await post('data-deletion', signed(W)).expect(200);
      const [job] = queue.jobs;
      const statsBefore = await statRows(d.workspaceId);
      expect(statsBefore).toHaveLength(2);

      expect(await run(job!)).toEqual({
        kind: 'completed',
        connectionsSeen: 1,
        connections: 1,
        pages: 2,
        comments: 2,
        webhookEvents: 2,
        moderationActions: 2,
      });
      expect(await actionRows(d.workspaceId)).toHaveLength(0);
      expect(await policyRows(d.workspaceId)).toHaveLength(1);
      expect(await connection(d.workspaceId)).toBeUndefined();
      expect(await pages(d.workspaceId)).toHaveLength(0);
      expect(await commentRows(d.workspaceId)).toHaveLength(0);
      expect(await eventRows(d.workspaceId)).toHaveLength(0);
      expect(await statRows(d.workspaceId)).toEqual(statsBefore);

      // Other workspace untouched.
      expect(await connection(c.workspaceId)).toBeDefined();
      expect(await pages(c.workspaceId)).toHaveLength(1);
      expect(await commentRows(c.workspaceId)).toHaveLength(1);
      expect(await eventRows(c.workspaceId)).toHaveLength(1);
      expect(await actionRows(c.workspaceId)).toHaveLength(1);

      const res = await http()
        .get(`/api/meta/data-deletion/${code}`)
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'COMPLETED',
        completedAt: expect.any(String),
      });

      // Running the job again does nothing.
      expect(await run(job!)).toEqual({ kind: 'already_completed' });
    });

    it('a new request after completion gets a new code; an unknown user completes with nothing deleted', async () => {
      const res = await post('data-deletion', signed(W)).expect(200);
      expect(res.body.confirmation_code).not.toBe(code);
      expect(await requestRows(W)).toHaveLength(2);
      expect(await run(queue.jobs[0]!)).toMatchObject({
        kind: 'completed',
        connectionsSeen: 0,
        connections: 0,
      });
    });

    it('queue failure → 503; the request stays PENDING and a retry reuses it', async () => {
      queue.failAdds(new Error('redis down'));
      await post('data-deletion', signed(UNKNOWN)).expect(503);
      const [row] = await requestRows(UNKNOWN);
      expect(row).toMatchObject({ status: 'PENDING' });
      queue.failAdds(null);
      const res = await post('data-deletion', signed(UNKNOWN)).expect(200);
      expect(res.body.confirmation_code).toBe(row!.confirmationCode);
      expect(queue.jobs).toHaveLength(1);
    });

    it('unknown or malformed code → 404', async () => {
      await http()
        .get(`/api/meta/data-deletion/${'Z'.repeat(22)}`)
        .expect(404);
      await http().get('/api/meta/data-deletion/not-a-code').expect(404);
    });

    it('needs no session (public) and accepts no other method', async () => {
      await http().get('/api/meta/deauthorize').expect(404);
    });
  });

  it('cleanup sees every request row of this spec', async () => {
    const rows = await db()
      .select({ id: metaDataDeletionRequests.id })
      .from(metaDataDeletionRequests)
      .where(inArray(metaDataDeletionRequests.facebookUserId, [W, UNKNOWN]));
    expect(rows).toHaveLength(3);
  });
});

describe('Meta callbacks rate limit (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(META_CALLBACKS_CONFIG)
        .useValue({ appSecret: SECRET, clientAppUrl: CLIENT }),
    );
  });
  afterAll(async () => {
    await app?.close();
  });

  it(`answers 429 after ${META_CALLBACK_THROTTLE.limit} requests per minute per IP and route`, async () => {
    const { default: request } = await import('supertest');
    const http = () => request(app.getHttpServer());
    for (let i = 0; i < META_CALLBACK_THROTTLE.limit; i++) {
      await http()
        .post('/api/meta/deauthorize')
        .type('form')
        .send({})
        .expect(400);
    }
    const res = await http()
      .post('/api/meta/deauthorize')
      .type('form')
      .send({})
      .expect(429);
    expect(res.body).toMatchObject({ statusCode: 429 });
    // Another route has its own budget.
    await http()
      .post('/api/meta/data-deletion')
      .type('form')
      .send({})
      .expect(400);
  });

  it('keys on the resolved client IP (TRUST_PROXY_HOPS=1): spoofed left entries share one bucket', async () => {
    const { default: request } = await import('supertest');
    const deauthorize = (xff: string) =>
      request(app.getHttpServer())
        .post('/api/meta/deauthorize')
        .set('X-Forwarded-For', xff)
        .type('form')
        .send({});
    for (let i = 0; i < META_CALLBACK_THROTTLE.limit; i++) {
      await deauthorize(`198.51.100.${i + 1}, 203.0.113.50`).expect(400);
    }
    await deauthorize('198.51.100.200, 203.0.113.50').expect(429);
    // The proxy-added (last) entry is the key: another client has its own budget.
    await deauthorize('203.0.113.50, 203.0.113.51').expect(400);
  });
});
