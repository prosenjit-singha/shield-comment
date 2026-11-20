import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type { CommentFeedItem } from '../src/comments/dto/comments-feed.dto.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import {
  type CommentPlatform,
  comments,
  type MetaConnectionStatus,
  metaConnections,
  moderationActions,
  socialPages,
} from '../src/db/schema/index.js';
import { MetaGraphClient } from '../src/meta/meta-graph.client.js';
import { MetaGraphError } from '../src/meta/meta-graph.errors.js';
import { CommentModerationService } from '../src/moderation/comment-moderation.service.js';
import { ModerationActionExecutor } from '../src/moderation/moderation-action.executor.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import {
  FAKE_REPLY_ID,
  fakeCommentActionGraph,
} from './utils/fake-meta-graph.js';

const AUTHOR_ID = '777000111222444';
const RAW_MARKER = 'raw-payload-marker-m6t4';
const REPLY_TEXT = 'ধন্যবাদ! Inbox e details pathachhi.';

/**
 * M6-T4: `POST /api/workspaces/:workspaceId/comments/:commentId/override` (Module 6 D7/D8) on the
 * real executor + Postgres + token cipher. `MetaGraphClient` is the strict fake (only the four
 * comment actions answer) and the global `fetch` throws, so no live call can happen.
 */
describe('Comment override API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  const graph = fakeCommentActionGraph();
  let owner: Actor;
  let other: Actor;
  let moderator: Actor;
  let outsider: Actor;
  let superAdmin: Actor;
  let page: { id: string; pageId: string; token: string };
  let otherPage: { id: string; pageId: string; token: string };
  const fetchSpy = vi.fn(() => {
    throw new Error('unexpected live call');
  });
  let realFetch: typeof fetch;

  const base = `8${Date.now()}`;
  let seq = 40;
  const next = () => `${base}${++seq}`;

  async function insertConnection(actor: Actor, status: MetaConnectionStatus) {
    const fbUserId = next();
    await actors.db.insert(metaConnections).values({
      workspaceId: actor.workspaceId,
      facebookUserId: fbUserId,
      encryptedUserAccessToken: cipher.encrypt(
        `EAAuser${fbUserId}`,
        tokenCipherContext('meta_user_token', actor.workspaceId, fbUserId),
      ),
      grantedScopes: ['pages_manage_engagement'],
      status,
      statusChangedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  }

  async function insertPage(
    workspaceId: string,
    patch: Partial<typeof socialPages.$inferInsert> = {},
  ) {
    const pageId = next();
    const token = `EAApage${pageId}x`;
    const [row] = await actors.db
      .insert(socialPages)
      .values({
        workspaceId,
        pageId,
        pageName: `Shop ${pageId}`,
        igBusinessId: next(),
        encryptedPageAccessToken: cipher.encrypt(
          token,
          tokenCipherContext('meta_page_token', workspaceId, pageId),
        ),
        isActive: true,
        ...patch,
      })
      .returning();
    return { id: row!.id, pageId, token };
  }

  async function insertComment(
    patch: Partial<typeof comments.$inferInsert> = {},
    platform: CommentPlatform = 'FACEBOOK',
    workspaceId = owner.workspaceId,
    pageRowId: string | null = page.id,
  ) {
    const n = next();
    const metaCommentId = platform === 'FACEBOOK' ? `${n}_${n}9` : n;
    const [row] = await actors.db
      .insert(comments)
      .values({
        commentId: metaCommentId,
        workspaceId,
        socialPageId: pageRowId,
        platform,
        postId: `${n}_${n}`,
        authorId: AUTHOR_ID,
        authorName: 'Rahim',
        message: 'bKash e 500 taka cashback, link e click korun',
        rawPayload: { marker: RAW_MARKER },
        status: 'VISIBLE',
        ...patch,
      })
      .returning();
    return { id: row!.id, metaCommentId };
  }

  const path = (workspaceId: string, commentId: string) =>
    `/api/workspaces/${workspaceId}/comments/${commentId}/override`;
  const post = (
    cookie: string,
    workspaceId: string,
    commentId: string,
    body: Record<string, unknown>,
  ) =>
    actors
      .http()
      .post(path(workspaceId, commentId))
      .set('Cookie', cookie)
      .send(body);
  const act = (commentId: string, body: Record<string, unknown>) =>
    post(owner.cookie, owner.workspaceId, commentId, body);

  const commentRow = async (id: string) =>
    (await actors.db.select().from(comments).where(eq(comments.id, id)))[0]!;
  const actionsOf = (commentId: string) =>
    actors.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.commentId, commentId));
  const graphCalls = () =>
    graph.hideComment.mock.calls.length +
    graph.unhideComment.mock.calls.length +
    graph.deleteComment.mock.calls.length +
    graph.replyToComment.mock.calls.length;

  beforeAll(async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    app = await createTestApp((builder) =>
      builder.overrideProvider(MetaGraphClient).useValue(graph),
    );
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    owner = await actors.signUp('m6t4-owner');
    other = await actors.signUp('m6t4-other');
    moderator = await actors.signUp('m6t4-mod');
    outsider = await actors.signUp('m6t4-outsider');
    superAdmin = await actors.signUpSuperAdmin('m6t4-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    await insertConnection(owner, 'ACTIVE');
    await insertConnection(other, 'ACTIVE');
    page = await insertPage(owner.workspaceId);
    otherPage = await insertPage(other.workspaceId);
  });

  beforeEach(() => {
    graph.enabled = true;
    graph.hideComment.mockReset().mockResolvedValue(undefined);
    graph.unhideComment.mockReset().mockResolvedValue(undefined);
    graph.deleteComment.mockReset().mockResolvedValue(undefined);
    graph.replyToComment.mockReset().mockResolvedValue({ id: FAKE_REPLY_ID });
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
    globalThis.fetch = realFetch;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('actions (exact Graph call per action)', () => {
    it('HIDE → hideComment(platform, Meta id, Page token), HIDDEN + stamp + USER row', async () => {
      const c = await insertComment({ status: 'NEEDS_REVIEW' });
      const res = await act(c.id, { action: 'HIDE' }).expect(200);
      expect(graph.hideComment.mock.calls).toEqual([
        ['FACEBOOK', c.metaCommentId, page.token],
      ]);
      expect(graphCalls()).toBe(1);
      const item = res.body as CommentFeedItem;
      expect(item).toMatchObject({
        id: c.id,
        status: 'HIDDEN',
        overriddenAt: expect.any(String),
        lastAction: { action: 'HIDE', source: 'USER', state: 'SUCCEEDED' },
      });
      const [row] = await actionsOf(c.id);
      expect(row).toMatchObject({
        action: 'HIDE',
        source: 'USER',
        userId: owner.id,
        state: 'SUCCEEDED',
      });
    });

    it('UNHIDE on Instagram → unhideComment + VISIBLE', async () => {
      const c = await insertComment({ status: 'HIDDEN' }, 'INSTAGRAM');
      const res = await act(c.id, { action: 'UNHIDE' }).expect(200);
      expect(graph.unhideComment.mock.calls).toEqual([
        ['INSTAGRAM', c.metaCommentId, page.token],
      ]);
      expect(res.body.status).toBe('VISIBLE');
      expect((await commentRow(c.id)).status).toBe('VISIBLE');
    });

    it('DELETE → deleteComment(Meta id, token) + DELETED', async () => {
      const c = await insertComment();
      const res = await act(c.id, { action: 'DELETE' }).expect(200);
      expect(graph.deleteComment.mock.calls).toEqual([
        [c.metaCommentId, page.token],
      ]);
      expect(res.body.status).toBe('DELETED');
      expect((await commentRow(c.id)).deletedAt).not.toBeNull();
    });

    it('REPLY → the trimmed text, status unchanged, reply id logged', async () => {
      const c = await insertComment({ status: 'NEEDS_REVIEW' });
      const res = await act(c.id, {
        action: 'REPLY',
        replyText: `  ${REPLY_TEXT}  `,
      }).expect(200);
      expect(graph.replyToComment.mock.calls).toEqual([
        ['FACEBOOK', c.metaCommentId, REPLY_TEXT, page.token],
      ]);
      expect(res.body).toMatchObject({
        status: 'NEEDS_REVIEW',
        overriddenAt: expect.any(String),
        lastAction: { action: 'REPLY', source: 'USER', state: 'SUCCEEDED' },
      });
      const [row] = await actionsOf(c.id);
      expect(row!.replyCommentId).toBe(FAKE_REPLY_ID);
    });

    it('KEEP (D8) → VISIBLE + stamp + a SUCCEEDED KEEP row, no Graph call', async () => {
      const c = await insertComment({
        status: 'NEEDS_REVIEW',
        statusReason: 'below_threshold',
      });
      const res = await act(c.id, { action: 'KEEP' }).expect(200);
      expect(graphCalls()).toBe(0);
      expect(res.body).toMatchObject({
        status: 'VISIBLE',
        overriddenAt: expect.any(String),
        lastAction: { action: 'KEEP', source: 'USER', state: 'SUCCEEDED' },
      });
      const rows = await actionsOf(c.id);
      expect(rows).toEqual([
        expect.objectContaining({
          action: 'KEEP',
          userId: owner.id,
          state: 'SUCCEEDED',
          completedAt: expect.any(Date),
        }),
      ]);
    });

    it('KEEP needs no Meta: works on a disconnected Page with Meta unset', async () => {
      graph.enabled = false;
      const c = await insertComment(
        { status: 'FAILED' },
        'FACEBOOK',
        undefined,
        null,
      );
      const res = await act(c.id, { action: 'KEEP' }).expect(200);
      expect(res.body).toMatchObject({ status: 'VISIBLE', page: null });
    });

    it('KEEP on a hidden comment → 409 COMMENT_HIDDEN (unhide instead), nothing written', async () => {
      const c = await insertComment({ status: 'HIDDEN' });
      const res = await act(c.id, { action: 'KEEP' }).expect(409);
      expect(res.body.code).toBe('COMMENT_HIDDEN');
      expect(await actionsOf(c.id)).toEqual([]);
      expect((await commentRow(c.id)).overriddenAt).toBeNull();
    });

    it('answers the same item the feed shows (no raw payload, author id or token)', async () => {
      const c = await insertComment();
      const res = await act(c.id, { action: 'HIDE' }).expect(200);
      const feed = await actors
        .http()
        .get(`/api/workspaces/${owner.workspaceId}/comments`)
        .query({ limit: '50' })
        .set('Cookie', owner.cookie)
        .expect(200);
      const fromFeed = (feed.body.items as CommentFeedItem[]).find(
        (i) => i.id === c.id,
      );
      expect(res.body).toEqual(fromFeed);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(AUTHOR_ID);
      expect(text).not.toContain(RAW_MARKER);
      expect(text).not.toContain(page.token);
      expect(text).not.toContain(c.metaCommentId);
    });
  });

  it('D10: a later AI run leaves an overridden comment alone', async () => {
    const c = await insertComment({ moderationStage: 'classify' });
    await act(c.id, { action: 'HIDE' }).expect(200);
    graph.hideComment.mockClear();
    const moderated = await app
      .get(CommentModerationService)
      .moderate(
        { workspaceId: owner.workspaceId, commentRowId: c.id, editedAt: null },
        { finalAttempt: false },
      );
    expect(moderated).toEqual({ kind: 'skipped', reason: 'human_override' });
    const auto = await app.get(ModerationActionExecutor).execute({
      workspaceId: owner.workspaceId,
      commentId: c.id,
      action: 'UNHIDE',
      source: 'AUTO',
    });
    expect(auto).toEqual({ outcome: 'skipped', reason: 'human_override' });
    expect(graphCalls()).toBe(0);
    expect((await commentRow(c.id)).status).toBe('HIDDEN');
  });

  // PAGE_TOKEN_MISSING is unit-tested only: an active Page always has a token (DB check).
  describe('errors', () => {
    it.each([
      ['comment deleted', 'COMMENT_DELETED'],
      ['Page disconnected', 'PAGE_DISCONNECTED'],
      ['Page inactive', 'PAGE_INACTIVE'],
      ['Page token undecryptable', 'PAGE_TOKEN_UNDECRYPTABLE'],
    ] as const)(
      '%s → 409 %s, no Graph call, nothing written',
      async (name, code) => {
        let c: { id: string };
        if (name === 'comment deleted') {
          c = await insertComment({ status: 'DELETED', deletedAt: new Date() });
        } else if (name === 'Page disconnected') {
          c = await insertComment({}, 'FACEBOOK', undefined, null);
        } else {
          const p = await insertPage(owner.workspaceId, {
            isActive: name !== 'Page inactive',
            ...(name === 'Page token undecryptable' && {
              // Encrypted for another Page: the context check fails.
              encryptedPageAccessToken: cipher.encrypt(
                'EAAwrong',
                tokenCipherContext('meta_page_token', owner.workspaceId, '1'),
              ),
            }),
          });
          c = await insertComment({}, 'FACEBOOK', undefined, p.id);
        }
        const res = await act(c.id, { action: 'HIDE' }).expect(409);
        expect(res.body).toMatchObject({ statusCode: 409, code });
        expect(graphCalls()).toBe(0);
        expect(await actionsOf(c.id)).toEqual([]);
      },
    );

    it('connection not ACTIVE → 409 CONNECTION_INACTIVE', async () => {
      const c = await insertComment();
      const setStatus = (status: MetaConnectionStatus) =>
        actors.db
          .update(metaConnections)
          .set({ status })
          .where(eq(metaConnections.workspaceId, owner.workspaceId));
      await setStatus('NEEDS_REAUTH');
      try {
        const res = await act(c.id, { action: 'UNHIDE' }).expect(409);
        expect(res.body.code).toBe('CONNECTION_INACTIVE');
      } finally {
        await setStatus('ACTIVE');
      }
      expect(graphCalls()).toBe(0);
    });

    it('Meta not configured → 503 META_NOT_CONFIGURED', async () => {
      graph.enabled = false;
      const c = await insertComment();
      const res = await act(c.id, { action: 'HIDE' }).expect(503);
      expect(res.body.code).toBe('META_NOT_CONFIGURED');
      expect(graphCalls()).toBe(0);
    });

    it('Graph failure → 502 META_ACTION_FAILED { errorKind, retryable }, FAILED row', async () => {
      graph.hideComment.mockRejectedValueOnce(
        new MetaGraphError('rate_limited', 'Meta Graph 400 (#4): limit', {
          status: 400,
          code: 4,
        }),
      );
      const c = await insertComment();
      const res = await act(c.id, { action: 'HIDE' }).expect(502);
      expect(res.body).toMatchObject({
        code: 'META_ACTION_FAILED',
        details: { errorKind: 'rate_limited', retryable: true },
      });
      const [row] = await actionsOf(c.id);
      expect(row).toMatchObject({ state: 'FAILED', errorKind: 'rate_limited' });
      expect((await commentRow(c.id)).status).toBe('VISIBLE');
    });

    it.each([
      [{}],
      [{ action: 'NONE' }],
      [{ action: 'REPLY' }],
      [{ action: 'REPLY', replyText: '  ' }],
      [{ action: 'REPLY', replyText: 'x'.repeat(501) }],
      [{ action: 'HIDE', replyText: 'hi' }],
      [{ action: 'HIDE', userId: 'x' }],
    ])('400 for %j', async (body) => {
      const c = await insertComment();
      await act(c.id, body).expect(400);
      expect(graphCalls()).toBe(0);
    });
  });

  describe('access (D7) + tenant isolation', () => {
    it('401 without a session; 404 for a non-member, a malformed or unknown id', async () => {
      const c = await insertComment();
      await actors
        .http()
        .post(path(owner.workspaceId, c.id))
        .send({ action: 'HIDE' })
        .expect(401);
      await post(outsider.cookie, owner.workspaceId, c.id, {
        action: 'HIDE',
      }).expect(404);
      await act('not-a-uuid', { action: 'HIDE' }).expect(404);
      await act('019a4f3e-1c2d-7abc-8def-0123456789ab', {
        action: 'HIDE',
      }).expect(404);
      expect(graphCalls()).toBe(0);
    });

    it("another workspace's comment → 404, untouched", async () => {
      const foreign = await insertComment(
        {},
        'FACEBOOK',
        other.workspaceId,
        otherPage.id,
      );
      await act(foreign.id, { action: 'DELETE' }).expect(404);
      await act(foreign.id, { action: 'KEEP' }).expect(404);
      await post(other.cookie, other.workspaceId, foreign.id, {
        action: 'KEEP',
      }).expect(200);
      expect(graphCalls()).toBe(0);
      const own = await insertComment();
      await post(other.cookie, other.workspaceId, own.id, {
        action: 'HIDE',
      }).expect(404);
      expect((await commentRow(own.id)).overriddenAt).toBeNull();
    });

    it('a moderator may act; the row carries the moderator', async () => {
      const cookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      const c = await insertComment({ status: 'HIDDEN' });
      await post(cookie, owner.workspaceId, c.id, { action: 'UNHIDE' }).expect(
        200,
      );
      const [row] = await actionsOf(c.id);
      expect(row!.userId).toBe(moderator.id);
    });

    it('an impersonated session may act; the row carries the session user', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      const c = await insertComment({ status: 'NEEDS_REVIEW' });
      await post(cookie, owner.workspaceId, c.id, { action: 'KEEP' }).expect(
        200,
      );
      const [row] = await actionsOf(c.id);
      expect(row!.userId).toBe(owner.id);
    });
  });
});
