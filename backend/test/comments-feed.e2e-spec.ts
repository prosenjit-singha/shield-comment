import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import type { CommentFeedItem } from '../src/comments/dto/comments-feed.dto.js';
import {
  comments,
  type CommentPlatform,
  type CommentStatus,
  moderationActions,
  socialPages,
} from '../src/db/schema/index.js';
import type { ModerationCategory } from '../src/moderation/moderation.constants.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/** 2030-06-15 12:00 Dhaka. */
const T = new Date('2030-06-15T06:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AUTHOR_ID = '777000111222333';
const RAW_MARKER = 'raw-payload-marker-m6t3';

/**
 * M6-T3: workspace comments feed (D1 `since` polling, D7 every member + impersonation).
 * Seeded rows only; no external call is made (global `fetch` throws).
 */
describe('Comments feed API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let owner: Actor;
  let other: Actor;
  let moderator: Actor;
  let outsider: Actor;
  let superAdmin: Actor;
  let pageA: { id: string; name: string };
  let pageB: { id: string; name: string };
  /** Owner's comment ids, newest first (the feed order). */
  const ids: Record<string, string> = {};
  let order: string[];
  let otherCommentId: string;
  const fetchSpy = vi.fn(() => {
    throw new Error('unexpected live call');
  });
  let realFetch: typeof fetch;

  const base = `8${Date.now()}`;
  let seq = 0;
  const metaId = () => `${base}${seq++}`;

  const path = (workspaceId: string) =>
    `/api/workspaces/${workspaceId}/comments`;
  const get = (cookie: string, workspaceId: string, query = {}) =>
    actors.http().get(path(workspaceId)).query(query).set('Cookie', cookie);
  const list = async (query: Record<string, string> = {}) =>
    (await get(owner.cookie, owner.workspaceId, query).expect(200)).body as {
      items: CommentFeedItem[];
      nextCursor: string | null;
    };
  const listIds = async (query: Record<string, string> = {}) =>
    (await list({ limit: '50', ...query })).items.map((item) => item.id);

  async function insertPage(workspaceId: string, name: string) {
    const [page] = await actors.db
      .insert(socialPages)
      .values({ workspaceId, pageId: metaId(), pageName: name })
      .returning();
    return { id: page!.id, name: page!.pageName };
  }

  async function insertComment(input: {
    workspaceId: string;
    at: Date;
    message: string;
    pageId?: string | null;
    platform?: CommentPlatform;
    status?: CommentStatus;
    category?: ModerationCategory;
    statusReason?: string;
    ruleMatch?: string;
  }): Promise<string> {
    const [row] = await actors.db
      .insert(comments)
      .values({
        commentId: `${metaId()}_${metaId()}`,
        workspaceId: input.workspaceId,
        socialPageId: input.pageId ?? null,
        platform: input.platform ?? 'FACEBOOK',
        postId: `${metaId()}_${metaId()}`,
        authorId: AUTHOR_ID,
        authorName: 'Rahim',
        message: input.message,
        rawPayload: { marker: RAW_MARKER },
        status: input.status ?? 'PENDING',
        statusReason: input.statusReason ?? null,
        ruleMatch: input.ruleMatch ?? null,
        createdAt: input.at,
        ...(input.category && {
          category: input.category,
          confidence: 0.912,
          reasoning: 'Asks for a bKash payment.',
          language: 'banglish',
          classifiedAt: input.at,
          aiProvider: 'neon',
          model: 'm6t3-e2e-model',
          promptVersion: 'moderation-v2',
          contextLevel: 'comment_only',
        }),
      })
      .returning({ id: comments.id });
    return row!.id;
  }

  beforeAll(async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    app = await createTestApp();
    actors = createAuthActors(app);
    owner = await actors.signUp('m6t3-owner');
    other = await actors.signUp('m6t3-other');
    moderator = await actors.signUp('m6t3-mod');
    outsider = await actors.signUp('m6t3-outsider');
    superAdmin = await actors.signUpSuperAdmin('m6t3-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    pageA = await insertPage(owner.workspaceId, 'Shop A');
    pageB = await insertPage(owner.workspaceId, 'Shop B');
    const ws = owner.workspaceId;

    ids.scam = await insertComment({
      workspaceId: ws,
      at: T,
      message: 'bKash 50% cashback',
      pageId: pageA.id,
      status: 'VISIBLE',
      category: 'SCAM_PHISHING',
      statusReason: 'below_threshold',
    });
    ids.ig = await insertComment({
      workspaceId: ws,
      at: new Date(T.getTime() - HOUR),
      message: 'price koto?',
      pageId: pageA.id,
      platform: 'INSTAGRAM',
      status: 'VISIBLE',
      category: 'SAFE_INQUIRY',
    });
    ids.rule = await insertComment({
      workspaceId: ws,
      at: new Date(T.getTime() - DAY),
      message: 'deal 50_off at wa.me/123',
      pageId: pageB.id,
      status: 'NEEDS_REVIEW',
      statusReason: 'rule_url',
      ruleMatch: 'wa.me/123',
    });
    // Three rows with the same created_at: the cursor must break ties on id.
    const tie = new Date(T.getTime() - 2 * DAY);
    ids.tie1 = await insertComment({
      workspaceId: ws,
      at: tie,
      message: '50 off one',
    });
    ids.tie2 = await insertComment({
      workspaceId: ws,
      at: tie,
      message: 'two',
    });
    ids.tie3 = await insertComment({
      workspaceId: ws,
      at: tie,
      message: 'three',
    });
    // Dhaka day bounds: 2030-06-12 00:00 Dhaka, and 1 ms before it (2030-06-11).
    ids.midnight = await insertComment({
      workspaceId: ws,
      at: new Date('2030-06-11T18:00:00.000Z'),
      message: 'Disconnected page comment',
      status: 'HIDDEN',
    });
    ids.before = await insertComment({
      workspaceId: ws,
      at: new Date('2030-06-11T17:59:59.999Z'),
      message: 'late night',
    });
    const [t1, t2, t3] = [ids.tie1!, ids.tie2!, ids.tie3!].sort().reverse();
    order = [
      ids.scam!,
      ids.ig!,
      ids.rule!,
      t1!,
      t2!,
      t3!,
      ids.midnight!,
      ids.before!,
    ];

    // scam: AUTO hide, then a later USER unhide still pending → lastAction = the unhide.
    await actors.db.insert(moderationActions).values([
      {
        workspaceId: ws,
        commentId: ids.scam!,
        action: 'HIDE',
        source: 'AUTO',
        state: 'SUCCEEDED',
        createdAt: new Date(T.getTime() + 1000),
        completedAt: new Date(T.getTime() + 2000),
      },
      {
        workspaceId: ws,
        commentId: ids.scam!,
        action: 'UNHIDE',
        source: 'USER',
        userId: owner.id,
        state: 'PENDING',
        createdAt: new Date(T.getTime() + 60_000),
      },
      {
        workspaceId: ws,
        commentId: ids.midnight!,
        action: 'HIDE',
        source: 'AUTO',
        state: 'SUCCEEDED',
        createdAt: new Date('2030-06-11T18:00:01.000Z'),
        completedAt: new Date('2030-06-11T18:00:02.000Z'),
      },
    ]);

    otherCommentId = await insertComment({
      workspaceId: other.workspaceId,
      at: T,
      message: 'bKash 50% cashback elsewhere',
    });
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
    globalThis.fetch = realFetch;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('items', () => {
    it('lists newest first with page, classification and the latest action', async () => {
      const body = await list({ limit: '50' });
      expect(body.items.map((i) => i.id)).toEqual(order);
      expect(body.nextCursor).toBeNull();
      expect(body.items[0]).toEqual({
        id: ids.scam,
        platform: 'FACEBOOK',
        page: pageA,
        postId: expect.any(String),
        authorName: 'Rahim',
        message: 'bKash 50% cashback',
        status: 'VISIBLE',
        statusReason: 'below_threshold',
        category: 'SCAM_PHISHING',
        confidence: 0.912,
        language: 'banglish',
        reasoning: 'Asks for a bKash payment.',
        ruleMatch: null,
        overriddenAt: null,
        editedAt: null,
        createdAt: T.toISOString(),
        lastAction: {
          action: 'UNHIDE',
          source: 'USER',
          state: 'PENDING',
          at: new Date(T.getTime() + 60_000).toISOString(),
        },
      });
      const byId = new Map(body.items.map((i) => [i.id, i]));
      expect(byId.get(ids.rule!)).toMatchObject({
        page: pageB,
        status: 'NEEDS_REVIEW',
        statusReason: 'rule_url',
        ruleMatch: 'wa.me/123',
        category: null,
        confidence: null,
        lastAction: null,
      });
      expect(byId.get(ids.midnight!)).toMatchObject({
        page: null,
        lastAction: {
          action: 'HIDE',
          source: 'AUTO',
          state: 'SUCCEEDED',
          at: '2030-06-11T18:00:02.000Z',
        },
      });
    });

    it('never returns the raw payload, the author id or tokens', async () => {
      const res = await get(owner.cookie, owner.workspaceId, { limit: '50' });
      expect(res.text).not.toContain(RAW_MARKER);
      expect(res.text).not.toContain(AUTHOR_ID);
      for (const item of res.body.items as Record<string, unknown>[]) {
        expect(Object.keys(item)).not.toEqual(
          expect.arrayContaining(['rawPayload']),
        );
        expect(item).not.toHaveProperty('authorId');
        expect(item).not.toHaveProperty('commentId');
        expect(item).not.toHaveProperty('workspaceId');
      }
      expect(res.text).not.toMatch(/token/i);
    });
  });

  describe('filters', () => {
    it('status, category, platform and pageId', async () => {
      expect(await listIds({ status: 'HIDDEN' })).toEqual([ids.midnight]);
      expect(await listIds({ status: 'VISIBLE' })).toEqual([ids.scam, ids.ig]);
      expect(await listIds({ category: 'SAFE_INQUIRY' })).toEqual([ids.ig]);
      expect(await listIds({ platform: 'INSTAGRAM' })).toEqual([ids.ig]);
      expect(await listIds({ platform: 'FACEBOOK' })).toHaveLength(7);
      expect(await listIds({ pageId: pageB.id })).toEqual([ids.rule]);
      expect(await listIds({ pageId: pageA.id, platform: 'FACEBOOK' })).toEqual(
        [ids.scam],
      );
    });

    it('from/to are inclusive Dhaka days', async () => {
      expect(await listIds({ from: '2030-06-12', to: '2030-06-12' })).toEqual([
        ids.midnight,
      ]);
      expect(await listIds({ to: '2030-06-11' })).toEqual([ids.before]);
      expect(await listIds({ from: '2030-06-15' })).toEqual([ids.scam, ids.ig]);
      expect(await listIds({ from: '2030-06-14', to: '2030-06-14' })).toEqual([
        ids.rule,
      ]);
    });

    it('q is a case-insensitive substring with % and _ taken literally', async () => {
      expect(await listIds({ q: 'BKASH' })).toEqual([ids.scam]);
      expect(await listIds({ q: '50%' })).toEqual([ids.scam]);
      expect(await listIds({ q: '50_' })).toEqual([ids.rule]);
      expect(await listIds({ q: '%' })).toEqual([ids.scam]);
      expect(await listIds({ q: '_' })).toEqual([ids.rule]);
      expect(await listIds({ q: '  50 off  ' })).toEqual([ids.tie1]);
    });

    it('since returns only comments created after the instant (D1)', async () => {
      expect(
        await listIds({ since: new Date(T.getTime() - DAY).toISOString() }),
      ).toEqual([ids.scam, ids.ig]);
      expect(await listIds({ since: T.toISOString() })).toEqual([]);
      expect(await listIds({ since: '2030-06-15T11:00:00+06:00' })).toEqual([
        ids.scam,
      ]);
    });
  });

  describe('cursor', () => {
    it('pages through every row without gaps or duplicates (ties on created_at)', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const body = await list({ limit: '2', ...(cursor ? { cursor } : {}) });
        seen.push(...body.items.map((i) => i.id));
        cursor = body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(seen).toEqual(order);
      expect(pages).toBe(4);
    });

    it('combines with filters', async () => {
      const first = await list({ status: 'PENDING', limit: '2' });
      expect(first.items).toHaveLength(2);
      const second = await list({
        status: 'PENDING',
        limit: '2',
        cursor: first.nextCursor!,
      });
      expect([...first.items, ...second.items].map((i) => i.id)).toEqual(
        order.filter((id) =>
          [ids.tie1, ids.tie2, ids.tie3, ids.before].includes(id),
        ),
      );
      expect(second.nextCursor).toBeNull();
    });

    it('defaults to 20 items', async () => {
      const body = await list();
      expect(body.items).toHaveLength(order.length);
    });
  });

  describe('validation', () => {
    it.each([
      [{ cursor: 'nope' }],
      [
        {
          cursor: Buffer.from('2030-06-15T06:00:00.000Z|x').toString(
            'base64url',
          ),
        },
      ],
      [{ limit: '51' }],
      [{ limit: '0' }],
      [{ status: 'hidden' }],
      [{ category: 'SCAM' }],
      [{ platform: 'TIKTOK' }],
      [{ pageId: '123' }],
      [{ from: '2030-02-30' }],
      [{ from: '2030-06-15', to: '2030-06-14' }],
      [{ since: '2030-06-15' }],
      [{ q: 'x'.repeat(101) }],
      [{ workspace: 'x' }],
    ])('400 for %j', async (query) => {
      await get(owner.cookie, owner.workspaceId, query).expect(400);
    });
  });

  describe('access (D7) + tenant isolation', () => {
    it('401 without a session; 404 for a non-member or a malformed id', async () => {
      await actors.http().get(path(owner.workspaceId)).expect(401);
      await get(outsider.cookie, owner.workspaceId).expect(404);
      await get(owner.cookie, 'not-a-uuid').expect(404);
    });

    it('a moderator may read the feed', async () => {
      const cookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      const res = await get(cookie, owner.workspaceId, { limit: '50' }).expect(
        200,
      );
      expect(res.body.items).toHaveLength(order.length);
    });

    it('an impersonated session reads its workspace only', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      const res = await get(cookie, owner.workspaceId).expect(200);
      expect(res.body.items[0].id).toBe(ids.scam);
      await actors.addMember(other.workspaceId, owner.id, 'admin');
      await get(cookie, other.workspaceId).expect(404);
    });

    it("never shows another workspace's comments", async () => {
      const mine = await get(other.cookie, other.workspaceId, {
        limit: '50',
      }).expect(200);
      expect(mine.body.items.map((i: CommentFeedItem) => i.id)).toEqual([
        otherCommentId,
      ]);
      expect(await listIds()).not.toContain(otherCommentId);
      expect(await listIds({ q: 'elsewhere' })).toEqual([]);
      // Another workspace's Page id filters to nothing.
      const foreign = await get(other.cookie, other.workspaceId, {
        pageId: pageA.id,
      }).expect(200);
      expect(foreign.body.items).toEqual([]);
    });
  });
});
