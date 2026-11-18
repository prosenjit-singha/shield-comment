import type { INestApplication } from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { CommentIngestProcessor } from '../src/comments/comment-ingest.processor.js';
import type { IngestOutcome } from '../src/comments/comment-ingest.service.js';
import {
  comments,
  dailyCommentStats,
  metaConnections,
  type MetaConnectionStatus,
  socialPages,
  webhookEvents,
} from '../src/db/schema/index.js';
import { QUEUE_NAMES } from '../src/queue/queue.constants.js';
import {
  COMMENT_INGEST_JOB_NAME,
  type CommentIngestJobData,
} from '../src/webhooks/comment-ingest.job.js';
import { parseMetaWebhookEnvelope } from '../src/webhooks/meta-webhook-envelope.js';
import {
  entry,
  envelope,
  fbCommentValue,
  igCommentValue,
} from './fixtures/meta-webhook-payloads.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { FakeWorker } from './utils/fake-worker.js';

/**
 * M4-T5: the `comment-ingest` worker against the real test DB (Module 4 D2/D3/D4/D9 + the
 * out-of-order decision 2026-11-18). Jobs are built by the real envelope parser (M4-T4) and handed
 * to `process(job)`; no real BullMQ Worker runs (`FakeWorker`).
 */
describe('Comment ingest worker (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let a: Actor;
  let b: Actor;
  let processor: CommentIngestProcessor;
  const pageRows: Record<string, string> = {};

  // Unique per run: Page / IG / comment ids are globally unique keys.
  const base = `7${Date.now()}`;
  const PAGE_A = `${base}1`;
  const IG_A = `${base}2`;
  const PAGE_A_OFF = `${base}3`;
  const PAGE_B = `${base}4`;
  const PAGE_UNKNOWN = `${base}5`;
  let seq = 100;
  const nextCommentId = () => `${base}${seq++}_${base}${seq++}`;
  const T0 = 1763480000; // 2025-11-18T15:33:20Z = Dhaka 2025-11-18

  const token = 'v1:e2e:iv:tag:ct';
  const db = () => actors.db;

  /** Job data for one FB feed change on `pageId`, as the receiver enqueues it. */
  function fbJob(
    pageId: string,
    value: Record<string, unknown>,
    time: number = T0,
  ): CommentIngestJobData {
    const post = `${pageId}_${base}9`;
    const body = envelope('page', [
      entry(
        pageId,
        [
          {
            field: 'feed',
            value: fbCommentValue({ post_id: post, parent_id: post, ...value }),
          },
        ],
        time,
      ),
    ]);
    const [job] = parseMetaWebhookEnvelope(JSON.stringify(body)).jobs;
    if (!job) throw new Error('fixture produced no job');
    return job.data;
  }

  function igJob(igId: string, value: Record<string, unknown>) {
    const body = envelope('instagram', [
      entry(igId, [{ field: 'comments', value: igCommentValue(value) }]),
    ]);
    return parseMetaWebhookEnvelope(JSON.stringify(body)).jobs[0]!.data;
  }

  const run = (data: unknown, name = COMMENT_INGEST_JOB_NAME) =>
    processor.process({
      id: (data as { eventId?: string }).eventId,
      name,
      data,
      opts: { attempts: 5 },
      attemptsMade: 0,
    } as unknown as Job<unknown, IngestOutcome>);

  const commentRows = (commentId: string) =>
    db().select().from(comments).where(eq(comments.commentId, commentId));
  const eventRows = (commentId: string) =>
    db()
      .select()
      .from(webhookEvents)
      .where(
        inArray(webhookEvents.eventId, [
          `FACEBOOK:${commentId}:add`,
          `FACEBOOK:${commentId}:remove`,
          `INSTAGRAM:${commentId}:add`,
        ]),
      );
  const stats = (workspaceId: string, pageId: string) =>
    db()
      .select()
      .from(dailyCommentStats)
      .where(
        and(
          eq(dailyCommentStats.workspaceId, workspaceId),
          eq(dailyCommentStats.pageId, pageId),
        ),
      );
  const setStatus = (workspaceId: string, status: MetaConnectionStatus) =>
    db()
      .update(metaConnections)
      .set({ status })
      .where(eq(metaConnections.workspaceId, workspaceId));

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    a = await actors.signUp('m4t5-a');
    b = await actors.signUp('m4t5-b');
    processor = app.get(CommentIngestProcessor);
    for (const [ws, fbUser] of [
      [a.workspaceId, `${base}61`],
      [b.workspaceId, `${base}62`],
    ] as const) {
      await db().insert(metaConnections).values({
        workspaceId: ws,
        facebookUserId: fbUser,
        encryptedUserAccessToken: token,
      });
    }
    const pages = await db()
      .insert(socialPages)
      .values([
        {
          workspaceId: a.workspaceId,
          pageId: PAGE_A,
          pageName: 'Shop A',
          igBusinessId: IG_A,
          igUsername: 'shop.a',
          encryptedPageAccessToken: token,
          isActive: true,
        },
        {
          workspaceId: a.workspaceId,
          pageId: PAGE_A_OFF,
          pageName: 'Shop A (off)',
          encryptedPageAccessToken: token,
          isActive: false,
        },
        {
          workspaceId: b.workspaceId,
          pageId: PAGE_B,
          pageName: 'Shop B',
          encryptedPageAccessToken: token,
          isActive: true,
        },
      ])
      .returning();
    for (const page of pages) pageRows[page.pageId] = page.id;
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('never starts a real BullMQ worker (FakeWorker on comment-ingest)', () => {
    const worker: unknown = processor.worker;
    expect(worker).toBeInstanceOf(FakeWorker);
    expect(worker).not.toBeInstanceOf(Worker);
    expect((worker as FakeWorker).name).toBe(QUEUE_NAMES.commentIngest);
  });

  it('add → one PENDING comment, a processed event and received +1', async () => {
    const commentId = nextCommentId();
    const data = fbJob(PAGE_A, { comment_id: commentId });
    expect(await run(data)).toMatchObject({
      kind: 'stored',
      workspaceId: a.workspaceId,
      action: 'created',
      moderate: true,
    });

    const [row, ...rest] = await commentRows(commentId);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      workspaceId: a.workspaceId,
      socialPageId: pageRows[PAGE_A],
      platform: 'FACEBOOK',
      postId: data.postId,
      authorId: data.authorId,
      authorName: data.authorName,
      message: data.message,
      status: 'PENDING',
      editedAt: null,
      deletedAt: null,
    });
    expect(row!.rawPayload).toEqual(data.rawPayload);
    const [event] = await eventRows(commentId);
    expect(event).toMatchObject({
      eventId: data.eventId,
      workspaceId: a.workspaceId,
      payloadHash: data.payloadHash,
    });
    expect(event!.processedAt).toBeInstanceOf(Date);
    expect(await stats(a.workspaceId, PAGE_A)).toMatchObject([
      { platform: 'FACEBOOK', day: '2025-11-18', receivedCount: 1 },
    ]);

    // The same job again (retry / duplicate delivery): nothing new.
    expect(await run(data)).toEqual({
      kind: 'duplicate',
      workspaceId: a.workspaceId,
    });
    expect(await commentRows(commentId)).toHaveLength(1);
    expect(await eventRows(commentId)).toHaveLength(1);
    expect(await stats(a.workspaceId, PAGE_A)).toMatchObject([
      { receivedCount: 1 },
    ]);
  });

  it('every different edit is applied; an older edit delivered late is not', async () => {
    const commentId = nextCommentId();
    await run(fbJob(PAGE_A, { comment_id: commentId, message: 'Dam koto?' }));
    const edit1 = fbJob(
      PAGE_A,
      { comment_id: commentId, verb: 'edited', message: 'bKash 01711111111' },
      T0 + 10,
    );
    const edit2 = fbJob(
      PAGE_A,
      { comment_id: commentId, verb: 'edited', message: 'Nagad 01722222222' },
      T0 + 20,
    );
    expect(await run(edit1)).toMatchObject({
      action: 'updated',
      moderate: true,
    });
    expect(await run(edit2)).toMatchObject({
      action: 'updated',
      moderate: true,
    });
    expect(await run(edit2)).toMatchObject({ kind: 'duplicate' });

    let [row] = await commentRows(commentId);
    expect(row).toMatchObject({
      message: 'Nagad 01722222222',
      editedAt: new Date((T0 + 20) * 1000),
    });
    expect(row!.rawPayload).toEqual(edit2.rawPayload);

    const stale = fbJob(
      PAGE_A,
      { comment_id: commentId, verb: 'edited', message: 'old text' },
      T0 + 15,
    );
    expect(await run(stale)).toMatchObject({
      action: 'updated',
      moderate: false,
    });
    [row] = await commentRows(commentId);
    expect(row!.message).toBe('Nagad 01722222222');

    const events = await db()
      .select()
      .from(webhookEvents)
      .where(
        inArray(webhookEvents.eventId, [
          edit1.eventId,
          edit2.eventId,
          stale.eventId,
        ]),
      );
    expect(events).toHaveLength(3);
    expect(await stats(a.workspaceId, PAGE_A)).toMatchObject([
      { receivedCount: 2, editedCount: 3, removedCount: 0 },
    ]);
  });

  it('edit before its add: stored from the edit; the late add keeps 1 row and the edit', async () => {
    const commentId = nextCommentId();
    const before = (await stats(a.workspaceId, PAGE_A))[0]!;
    expect(
      await run(
        fbJob(
          PAGE_A,
          { comment_id: commentId, verb: 'edited', message: 'bKash 017' },
          T0 + 30,
        ),
      ),
    ).toMatchObject({ action: 'created', moderate: true });
    expect(
      await run(fbJob(PAGE_A, { comment_id: commentId, message: 'original' })),
    ).toMatchObject({ action: 'unchanged', moderate: false });

    const rows = await commentRows(commentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message: 'bKash 017',
      status: 'PENDING',
      deletedAt: null,
    });
    expect(rows[0]!.editedAt).toBeInstanceOf(Date);
    expect(await eventRows(commentId)).toHaveLength(1); // the add event (edit ids differ)
    const after = (await stats(a.workspaceId, PAGE_A))[0]!;
    expect(after.receivedCount - before.receivedCount).toBe(1);
    expect(after.editedCount - before.editedCount).toBe(1);
  });

  it('remove marks the comment deleted (row kept)', async () => {
    const commentId = nextCommentId();
    await run(fbJob(PAGE_A, { comment_id: commentId }));
    const before = (await stats(a.workspaceId, PAGE_A))[0]!;
    expect(
      await run(
        fbJob(
          PAGE_A,
          { comment_id: commentId, verb: 'remove', message: undefined },
          T0 + 40,
        ),
      ),
    ).toMatchObject({ action: 'deleted', moderate: false });
    const [row] = await commentRows(commentId);
    expect(row!.deletedAt).toEqual(new Date((T0 + 40) * 1000));
    expect(row!.message).toBe(fbCommentValue().message);
    const after = (await stats(a.workspaceId, PAGE_A))[0]!;
    expect(after.removedCount - before.removedCount).toBe(1);
  });

  it('remove before its add: deleted placeholder; the late add does not bring it back', async () => {
    const commentId = nextCommentId();
    expect(
      await run(
        fbJob(PAGE_A, {
          comment_id: commentId,
          verb: 'remove',
          message: undefined,
        }),
      ),
    ).toMatchObject({ action: 'placeholder' });
    expect(
      await run(fbJob(PAGE_A, { comment_id: commentId, message: 'scam' })),
    ).toMatchObject({ action: 'unchanged' });
    const rows = await commentRows(commentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ message: null, status: 'PENDING' });
    expect(rows[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it('IG comments route by the IG business id and count under the linked Page', async () => {
    const commentId = `${base}${seq++}`;
    expect(await run(igJob(IG_A, { id: commentId }))).toMatchObject({
      action: 'created',
    });
    const [row] = await commentRows(commentId);
    expect(row).toMatchObject({
      workspaceId: a.workspaceId,
      socialPageId: pageRows[PAGE_A],
      platform: 'INSTAGRAM',
      message: igCommentValue().text,
      authorName: 'karim.shop',
    });
    const igStats = (await stats(a.workspaceId, PAGE_A)).filter(
      (s) => s.platform === 'INSTAGRAM',
    );
    expect(igStats).toMatchObject([{ receivedCount: 1 }]);
  });

  it.each([
    ['an unknown Page', () => PAGE_UNKNOWN, 'unknown_page'],
    ['an inactive Page', () => PAGE_A_OFF, 'inactive_page'],
  ])('drops a comment for %s: no rows', async (_l, page, reason) => {
    const commentId = nextCommentId();
    expect(await run(fbJob(page(), { comment_id: commentId }))).toEqual({
      kind: 'dropped',
      reason,
    });
    expect(await commentRows(commentId)).toHaveLength(0);
    expect(await eventRows(commentId)).toHaveLength(0);
    expect(await stats(a.workspaceId, page())).toHaveLength(0);
  });

  it('REVOKED connection drops (D9); NEEDS_REAUTH still ingests', async () => {
    try {
      await setStatus(b.workspaceId, 'REVOKED');
      const dropped = nextCommentId();
      expect(await run(fbJob(PAGE_B, { comment_id: dropped }))).toEqual({
        kind: 'dropped',
        reason: 'connection_revoked',
      });
      expect(await commentRows(dropped)).toHaveLength(0);
      expect(await eventRows(dropped)).toHaveLength(0);
      expect(await stats(b.workspaceId, PAGE_B)).toHaveLength(0);

      await setStatus(b.workspaceId, 'NEEDS_REAUTH');
      const stored = nextCommentId();
      expect(await run(fbJob(PAGE_B, { comment_id: stored }))).toMatchObject({
        kind: 'stored',
        workspaceId: b.workspaceId,
        action: 'created',
      });
      expect(await commentRows(stored)).toMatchObject([
        { workspaceId: b.workspaceId, socialPageId: pageRows[PAGE_B] },
      ]);
    } finally {
      await setStatus(b.workspaceId, 'ACTIVE');
    }
  });

  it('keeps two workspaces apart (a comment id of A delivered via B changes nothing)', async () => {
    const commentA = nextCommentId();
    const commentB = nextCommentId();
    await run(fbJob(PAGE_A, { comment_id: commentA, message: 'A text' }));
    await run(fbJob(PAGE_B, { comment_id: commentB, message: 'B text' }));
    expect(await commentRows(commentA)).toMatchObject([
      { workspaceId: a.workspaceId, message: 'A text' },
    ]);
    expect(await commentRows(commentB)).toMatchObject([
      { workspaceId: b.workspaceId, message: 'B text' },
    ]);

    // E.g. the Page moved to B after a disconnect: A's comment stays A's.
    const bStatsBefore = await stats(b.workspaceId, PAGE_B);
    // Event ids are global: A already recorded this `add`.
    expect(
      await run(fbJob(PAGE_B, { comment_id: commentA, message: 'other' })),
    ).toEqual({ kind: 'duplicate', workspaceId: b.workspaceId });
    for (const data of [
      fbJob(PAGE_B, {
        comment_id: commentA,
        verb: 'edited',
        message: 'hijack',
      }),
      fbJob(PAGE_B, {
        comment_id: commentA,
        verb: 'remove',
        message: undefined,
      }),
    ]) {
      expect(await run(data)).toMatchObject({
        kind: 'stored',
        workspaceId: b.workspaceId,
        action: 'unchanged',
      });
    }
    expect(await commentRows(commentA)).toMatchObject([
      { workspaceId: a.workspaceId, message: 'A text', deletedAt: null },
    ]);
    expect(await stats(b.workspaceId, PAGE_B)).toEqual(bStatsBefore);
  });

  it('rejects an invalid job without retries or rows', async () => {
    const commentId = nextCommentId();
    const data = fbJob(PAGE_A, { comment_id: commentId });
    await expect(run({ ...data, payloadHash: 'nope' })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(run(data, 'other-job')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(await commentRows(commentId)).toHaveLength(0);
    expect(await eventRows(commentId)).toHaveLength(0);
  });
});
