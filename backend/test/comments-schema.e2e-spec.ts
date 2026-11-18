import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  findWorkspaceComment,
  incrementDailyCommentStats,
  insertComment,
  insertWebhookEvent,
  listDailyCommentStats,
  listWorkspaceComments,
  markWebhookEventProcessed,
  webhookPayloadHash,
} from '../src/comments/comments.queries.js';
import {
  comments,
  dailyCommentStats,
  socialPages,
  webhookEvents,
  workspaces,
} from '../src/db/schema/index.js';
import { commentJobId } from '../src/queue/queue.constants.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/** Postgres SQLSTATE of a failed query (Drizzle wraps the `pg` error in `cause`). */
async function pgCode(
  query: PromiseLike<unknown>,
): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    const pgError = (error as { cause?: { code?: string } }).cause ?? error;
    return (pgError as { code?: string }).code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/**
 * M4-T2: `webhook_events`, `comments`, `daily_comment_stats` + the `comments.queries.ts` helpers
 * (user decisions 2026-11-18: Module 4 D4 storage, D7 disconnect keeps comments with the Page link
 * set to null). No HTTP routes yet (M4-T4/T5).
 */
describe('Comments schema (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let a: Actor;
  let b: Actor;
  let pageRowA: string;

  // Unique per run so stale rows can't collide with the global unique keys.
  const base = `8${Date.now()}`;
  const pageA = `${base}1`;
  const pageB = `${base}2`;
  const commentA1 = `${base}11_${base}12`;
  const commentA2 = `${base}13_${base}14`;
  const commentB1 = `${base}15_${base}16`;
  const postA = `${pageA}_${base}17`;
  const payload = { field: 'feed', value: { verb: 'add', message: 'hi' } };

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    a = await actors.signUp('m4t2-a');
    b = await actors.signUp('m4t2-b');
    const [row] = await db()
      .insert(socialPages)
      .values({ workspaceId: a.workspaceId, pageId: pageA, pageName: 'Shop A' })
      .returning();
    pageRowA = row!.id;
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  const db = () => actors.db;

  const comment = (
    workspaceId: string,
    commentId: string,
    extra: Partial<typeof comments.$inferInsert> = {},
  ) => ({
    commentId,
    workspaceId,
    platform: 'FACEBOOK' as const,
    postId: postA,
    authorId: `${base}99`,
    authorName: 'Rahim',
    message: 'bKash 017… send money',
    rawPayload: payload,
    ...extra,
  });

  describe('webhook_events', () => {
    const eventId = () => commentJobId('FACEBOOK', commentA1, 'add');

    it('records a new event once; a duplicate event_id is a no-op (D4)', async () => {
      const values = {
        eventId: eventId(),
        workspaceId: a.workspaceId,
        payloadHash: webhookPayloadHash(payload),
      };
      expect(await insertWebhookEvent(db(), values)).toBe(true);
      expect(await insertWebhookEvent(db(), values)).toBe(false);
      // Same event id from another workspace's delivery is still a duplicate (global key).
      expect(
        await insertWebhookEvent(db(), {
          ...values,
          workspaceId: b.workspaceId,
        }),
      ).toBe(false);
      const rows = await db()
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.eventId, eventId()));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        workspaceId: a.workspaceId,
        processedAt: null,
      });
    });

    it('marks processed only within the owning workspace', async () => {
      expect(
        await markWebhookEventProcessed(db(), b.workspaceId, eventId()),
      ).toBe(false);
      const at = new Date('2026-11-18T10:00:00.000Z');
      expect(
        await markWebhookEventProcessed(db(), a.workspaceId, eventId(), at),
      ).toBe(true);
      const [row] = await db()
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.eventId, eventId()));
      expect(row!.processedAt).toEqual(at);
    });

    it('rejects a malformed event id or payload hash', async () => {
      const valid = {
        eventId: commentJobId('INSTAGRAM', `${base}21`, 'edited'),
        workspaceId: a.workspaceId,
        payloadHash: webhookPayloadHash(payload),
      };
      for (const eventIdValue of [
        `TIKTOK:${base}21:add`,
        `FACEBOOK:${base}21:hide`,
        `FACEBOOK:abc:add`,
      ]) {
        expect(
          await pgCode(
            db()
              .insert(webhookEvents)
              .values({ ...valid, eventId: eventIdValue }),
          ),
        ).toBe(CHECK_VIOLATION);
      }
      expect(
        await pgCode(
          db()
            .insert(webhookEvents)
            .values({ ...valid, payloadHash: 'not-a-hash' }),
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  describe('comments', () => {
    it('inserts a PENDING comment once; a duplicate comment_id is a no-op', async () => {
      const row = await insertComment(
        db(),
        comment(a.workspaceId, commentA1, { socialPageId: pageRowA }),
      );
      expect(row).toMatchObject({
        commentId: commentA1,
        status: 'PENDING',
        socialPageId: pageRowA,
        editedAt: null,
        deletedAt: null,
        rawPayload: payload,
      });
      expect(
        await insertComment(
          db(),
          comment(a.workspaceId, commentA1, { message: 'other' }),
        ),
      ).toBeUndefined();
      const rows = await db()
        .select()
        .from(comments)
        .where(eq(comments.commentId, commentA1));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.message).toBe('bKash 017… send money');
    });

    it('stores comments without author/message and an IG plain numeric id', async () => {
      const row = await insertComment(
        db(),
        comment(a.workspaceId, `${base}31`, {
          platform: 'INSTAGRAM',
          postId: `${base}32`,
          authorId: null,
          authorName: null,
          message: null,
          rawPayload: null,
        }),
      );
      expect(row).toMatchObject({ authorId: null, message: null });
    });

    it('rejects a bad platform, status or non-numeric Meta ids', async () => {
      const valid = comment(a.workspaceId, `${base}41`);
      const bad: Partial<typeof comments.$inferInsert>[] = [
        { platform: 'TIKTOK' as 'FACEBOOK' },
        { status: 'HIDDEN' as 'PENDING' },
        { commentId: 'abc_123' },
        { postId: `${base}_x` },
        { authorId: 'me' },
      ];
      for (const extra of bad) {
        expect(
          await pgCode(
            db()
              .insert(comments)
              .values({ ...valid, ...extra }),
          ),
        ).toBe(CHECK_VIOLATION);
      }
    });

    it('lists only the workspace’s comments, newest first, without raw_payload', async () => {
      await insertComment(db(), comment(a.workspaceId, commentA2));
      await insertComment(db(), comment(b.workspaceId, commentB1));

      const listA = await listWorkspaceComments(db(), a.workspaceId);
      expect(listA.map((c) => c.commentId)).toEqual([
        commentA2,
        `${base}31`,
        commentA1,
      ]);
      expect(listA[0]).not.toHaveProperty('rawPayload');
      expect(
        (
          await listWorkspaceComments(db(), a.workspaceId, { skip: 1, take: 1 })
        ).map((c) => c.commentId),
      ).toEqual([`${base}31`]);

      const listB = await listWorkspaceComments(db(), b.workspaceId);
      expect(listB.map((c) => c.commentId)).toEqual([commentB1]);

      expect(
        await findWorkspaceComment(db(), a.workspaceId, commentA1),
      ).toMatchObject({ commentId: commentA1 });
      expect(
        await findWorkspaceComment(db(), b.workspaceId, commentA1),
      ).toBeUndefined();
    });

    it('rejects an unknown workspace or Page (FK)', async () => {
      expect(
        await pgCode(
          db()
            .insert(comments)
            .values(
              comment('0193b1a2-0000-7000-8000-00000000dead', `${base}51`),
            ),
        ),
      ).toBe(FK_VIOLATION);
      expect(
        await pgCode(
          db()
            .insert(comments)
            .values(
              comment(a.workspaceId, `${base}52`, {
                socialPageId: '0193b1a2-0000-7000-8000-00000000dead',
              }),
            ),
        ),
      ).toBe(FK_VIOLATION);
    });

    it('deleting the Page keeps its comments with the Page link set to null (D7)', async () => {
      await db().delete(socialPages).where(eq(socialPages.id, pageRowA));
      const [row] = await db()
        .select()
        .from(comments)
        .where(eq(comments.commentId, commentA1));
      expect(row).toMatchObject({
        socialPageId: null,
        message: 'bKash 017… send money',
        workspaceId: a.workspaceId,
      });
    });
  });

  describe('daily_comment_stats', () => {
    const key = () => ({
      workspaceId: a.workspaceId,
      pageId: pageA,
      platform: 'FACEBOOK' as const,
      day: '2026-11-18',
    });

    it('upsert-increments one row per key', async () => {
      const first = await incrementDailyCommentStats(db(), {
        ...key(),
        received: 1,
      });
      expect(first).toMatchObject({
        receivedCount: 1,
        editedCount: 0,
        removedCount: 0,
      });
      await incrementDailyCommentStats(db(), { ...key(), received: 2 });
      await incrementDailyCommentStats(db(), { ...key(), edited: 1 });
      const last = await incrementDailyCommentStats(db(), {
        ...key(),
        removed: 1,
      });
      expect(last).toMatchObject({
        id: first.id,
        receivedCount: 3,
        editedCount: 1,
        removedCount: 1,
      });
      // Other platform / day / workspace = separate rows.
      await incrementDailyCommentStats(db(), {
        ...key(),
        platform: 'INSTAGRAM',
        received: 1,
      });
      await incrementDailyCommentStats(db(), {
        ...key(),
        day: '2026-11-19',
        received: 1,
      });
      await incrementDailyCommentStats(db(), {
        ...key(),
        workspaceId: b.workspaceId,
        pageId: pageB,
        received: 5,
      });
      const rows = await db()
        .select()
        .from(dailyCommentStats)
        .where(eq(dailyCommentStats.workspaceId, a.workspaceId));
      expect(rows).toHaveLength(3);
    });

    it('lists only the workspace’s days in the inclusive range', async () => {
      const rows = await listDailyCommentStats(db(), a.workspaceId, {
        from: '2026-11-18',
        to: '2026-11-18',
      });
      expect(rows.map((r) => [r.day, r.platform, r.receivedCount])).toEqual([
        ['2026-11-18', 'FACEBOOK', 3],
        ['2026-11-18', 'INSTAGRAM', 1],
      ]);
      expect(
        await listDailyCommentStats(db(), b.workspaceId, {
          from: '2026-11-01',
          to: '2026-11-30',
        }),
      ).toHaveLength(1);
    });

    it('survives the Page being gone (no FK to social_pages)', async () => {
      // pageA's social_pages row was deleted above; the stats row is still there.
      const rows = await listDailyCommentStats(db(), a.workspaceId, {
        from: '2026-11-19',
        to: '2026-11-19',
      });
      expect(rows).toHaveLength(1);
    });

    it('rejects negative counts, a bad platform, a non-numeric Page id and duplicate keys', async () => {
      const valid = { ...key(), day: '2026-11-20' };
      for (const extra of [
        { receivedCount: -1 },
        { editedCount: -1 },
        { removedCount: -1 },
        { platform: 'TIKTOK' as 'FACEBOOK' },
        { pageId: 'page' },
      ]) {
        expect(
          await pgCode(
            db()
              .insert(dailyCommentStats)
              .values({ ...valid, ...extra }),
          ),
        ).toBe(CHECK_VIOLATION);
      }
      expect(
        await pgCode(
          db()
            .insert(dailyCommentStats)
            .values({ ...key() }),
        ),
      ).toBe(UNIQUE_VIOLATION);
    });
  });

  it('a workspace with webhook rows cannot be deleted (FK restrict)', async () => {
    expect(
      await pgCode(
        db().delete(workspaces).where(eq(workspaces.id, b.workspaceId)),
      ),
    ).toBe(FK_VIOLATION);
  });
});
