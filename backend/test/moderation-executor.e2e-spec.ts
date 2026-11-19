import { createHmac } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import type { Database } from '../src/db/database.js';
import {
  type CommentPlatform,
  comments,
  type MetaConnectionStatus,
  metaConnections,
  moderationActions,
  socialPages,
} from '../src/db/schema/index.js';
import { MetaGraphClient } from '../src/meta/meta-graph.client.js';
import type { MetaAppConfig } from '../src/meta/meta-graph.config.js';
import { MetaGraphError } from '../src/meta/meta-graph.errors.js';
import {
  type ExecuteModerationActionInput,
  ModerationActionExecutor,
} from '../src/moderation/moderation-action.executor.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import {
  FAKE_REPLY_ID,
  fakeCommentActionGraph,
} from './utils/fake-meta-graph.js';

const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const REPLY_TEXT = 'ধন্যবাদ! Inbox e details pathachhi.';

/**
 * M5-T9: the Meta action executor against real Postgres + the real token cipher (decisions
 * D3/D6/D10/D11). `MetaGraphClient` is the strict fake (only the four comment actions answer);
 * the "exact payloads" block (gate check 2) runs the real client with a stubbed `fetch` that
 * throws on anything but the expected Graph request.
 */
describe('Moderation action executor (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  let executor: ModerationActionExecutor;
  const graph = fakeCommentActionGraph();
  let owner: Actor;
  let other: Actor;
  let ownerPage: { id: string; pageId: string; token: string };
  let otherPage: { id: string; pageId: string; token: string };

  const db = (): Database => actors.db;
  const base = `8${Date.now()}`;
  let seq = 10;
  const next = () => `${base}${++seq}`;

  async function insertConnection(actor: Actor, status: MetaConnectionStatus) {
    const fbUserId = next();
    await db()
      .insert(metaConnections)
      .values({
        workspaceId: actor.workspaceId,
        facebookUserId: fbUserId,
        encryptedUserAccessToken: cipher.encrypt(
          `EAAuser${fbUserId}`,
          tokenCipherContext('meta_user_token', actor.workspaceId, fbUserId),
        ),
        grantedScopes: ['pages_manage_engagement'],
        status,
        statusChangedAt: LONG_AGO,
      });
  }

  async function insertPage(workspaceId: string, isActive = true) {
    const pageId = next();
    const token = `EAApage${pageId}x`;
    const [row] = await db()
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
        isActive,
      })
      .returning();
    return { id: row!.id, pageId, token };
  }

  /** A fresh comment on a Page; FB ids look like `<postId>_<commentId>`, IG ids are numbers. */
  async function insertComment(
    workspaceId: string,
    page: { id: string; pageId: string } | null,
    platform: CommentPlatform = 'FACEBOOK',
    patch: Partial<typeof comments.$inferInsert> = {},
  ) {
    const n = next();
    const metaCommentId = platform === 'FACEBOOK' ? `${n}_${n}9` : n;
    const [row] = await db()
      .insert(comments)
      .values({
        commentId: metaCommentId,
        workspaceId,
        socialPageId: page?.id ?? null,
        platform,
        postId: platform === 'FACEBOOK' ? `${page?.pageId ?? n}_${n}` : n,
        message: 'bKash e 500 taka cashback, link e click korun',
        status: 'VISIBLE',
        ...patch,
      })
      .returning();
    return { id: row!.id, metaCommentId };
  }

  const commentRow = async (id: string) =>
    (await db().select().from(comments).where(eq(comments.id, id)))[0]!;
  const actionsOf = (commentId: string) =>
    db()
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.commentId, commentId));
  const connectionOf = async (workspaceId: string) =>
    (
      await db()
        .select()
        .from(metaConnections)
        .where(eq(metaConnections.workspaceId, workspaceId))
    )[0]!;

  const auto = (
    commentId: string,
    action: 'HIDE' | 'UNHIDE' | 'DELETE',
    workspaceId = owner.workspaceId,
  ): ExecuteModerationActionInput => ({
    workspaceId,
    commentId,
    action,
    source: 'AUTO',
  });
  const autoReply = (commentId: string): ExecuteModerationActionInput => ({
    workspaceId: owner.workspaceId,
    commentId,
    action: 'REPLY',
    source: 'AUTO',
    replyText: REPLY_TEXT,
  });

  const graphCalls = () =>
    graph.hideComment.mock.calls.length +
    graph.unhideComment.mock.calls.length +
    graph.deleteComment.mock.calls.length +
    graph.replyToComment.mock.calls.length;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(MetaGraphClient).useValue(graph),
    );
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    executor = app.get(ModerationActionExecutor);
    owner = await actors.signUp('m5t9-owner');
    other = await actors.signUp('m5t9-other');
    await insertConnection(owner, 'ACTIVE');
    await insertConnection(other, 'ACTIVE');
    ownerPage = await insertPage(owner.workspaceId);
    otherPage = await insertPage(other.workspaceId);
  });

  beforeEach(() => {
    graph.hideComment.mockReset().mockResolvedValue(undefined);
    graph.unhideComment.mockReset().mockResolvedValue(undefined);
    graph.deleteComment.mockReset().mockResolvedValue(undefined);
    graph.replyToComment.mockReset().mockResolvedValue({ id: FAKE_REPLY_ID });
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('each action × platform', () => {
    it.each([
      ['HIDE', 'FACEBOOK', 'HIDDEN'],
      ['HIDE', 'INSTAGRAM', 'HIDDEN'],
      ['UNHIDE', 'FACEBOOK', 'VISIBLE'],
      ['UNHIDE', 'INSTAGRAM', 'VISIBLE'],
      ['DELETE', 'FACEBOOK', 'DELETED'],
      ['DELETE', 'INSTAGRAM', 'DELETED'],
    ] as const)(
      '%s on %s → Graph call + SUCCEEDED row + comment %s',
      async (action, platform, status) => {
        const comment = await insertComment(
          owner.workspaceId,
          ownerPage,
          platform,
          { status: action === 'UNHIDE' ? 'HIDDEN' : 'VISIBLE' },
        );
        const result = await executor.execute(auto(comment.id, action));
        expect(result).toMatchObject({
          outcome: 'succeeded',
          commentStatus: status,
          alreadyGone: false,
        });

        const method = {
          HIDE: graph.hideComment,
          UNHIDE: graph.unhideComment,
          DELETE: graph.deleteComment,
        }[action];
        expect(method).toHaveBeenCalledTimes(1);
        expect(method.mock.calls[0]).toEqual(
          action === 'DELETE'
            ? [comment.metaCommentId, ownerPage.token]
            : [platform, comment.metaCommentId, ownerPage.token],
        );
        expect(graphCalls()).toBe(1);

        const [row, ...rest] = await actionsOf(comment.id);
        expect(rest).toHaveLength(0);
        expect(row).toMatchObject({
          workspaceId: owner.workspaceId,
          action,
          source: 'AUTO',
          userId: null,
          state: 'SUCCEEDED',
          errorKind: null,
          replyCommentId: null,
        });
        expect(row!.completedAt).toBeInstanceOf(Date);
        expect(result.outcome === 'succeeded' ? result.actionId : null).toBe(
          row!.id,
        );

        const stored = await commentRow(comment.id);
        expect(stored.status).toBe(status);
        expect(stored.overriddenAt).toBeNull();
        if (action === 'DELETE') expect(stored.deletedAt).toBeInstanceOf(Date);
        else expect(stored.deletedAt).toBeNull();
      },
    );

    it.each(['FACEBOOK', 'INSTAGRAM'] as const)(
      'REPLY on %s → Graph reply + SUCCEEDED row with the reply id, status unchanged',
      async (platform) => {
        const comment = await insertComment(
          owner.workspaceId,
          ownerPage,
          platform,
        );
        const result = await executor.execute(autoReply(comment.id));
        expect(result).toMatchObject({
          outcome: 'succeeded',
          commentStatus: null,
          replyCommentId: FAKE_REPLY_ID,
        });
        expect(graph.replyToComment).toHaveBeenCalledExactlyOnceWith(
          platform,
          comment.metaCommentId,
          REPLY_TEXT,
          ownerPage.token,
        );
        const rows = await actionsOf(comment.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'REPLY',
          source: 'AUTO',
          state: 'SUCCEEDED',
          replyCommentId: FAKE_REPLY_ID,
        });
        expect((await commentRow(comment.id)).status).toBe('VISIBLE');
      },
    );
  });

  describe('idempotency', () => {
    it('an auto-reply is never sent twice; a FAILED one is retried on the same row', async () => {
      const comment = await insertComment(owner.workspaceId, ownerPage);
      graph.replyToComment.mockRejectedValueOnce(
        new MetaGraphError('rate_limited', 'Meta Graph 400 (#4): limit', {
          status: 400,
          code: 4,
        }),
      );
      await expect(
        executor.execute(autoReply(comment.id)),
      ).resolves.toMatchObject({
        outcome: 'failed',
        errorKind: 'rate_limited',
        retryable: true,
      });
      const [failed] = await actionsOf(comment.id);
      expect(failed).toMatchObject({
        state: 'FAILED',
        errorKind: 'rate_limited',
      });

      await expect(
        executor.execute(autoReply(comment.id)),
      ).resolves.toMatchObject({
        outcome: 'succeeded',
        actionId: failed!.id,
        replyCommentId: FAKE_REPLY_ID,
      });
      await expect(executor.execute(autoReply(comment.id))).resolves.toEqual({
        outcome: 'skipped',
        reason: 'already_replied',
      });
      expect(graph.replyToComment).toHaveBeenCalledTimes(2);
      const rows = await actionsOf(comment.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: failed!.id,
        state: 'SUCCEEDED',
        errorKind: null,
        replyCommentId: FAKE_REPLY_ID,
      });
    });

    it('two concurrent auto-replies send once', async () => {
      const comment = await insertComment(owner.workspaceId, ownerPage);
      const results = await Promise.all([
        executor.execute(autoReply(comment.id)),
        executor.execute(autoReply(comment.id)),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual([
        'skipped',
        'succeeded',
      ]);
      expect(graph.replyToComment).toHaveBeenCalledTimes(1);
      expect(await actionsOf(comment.id)).toHaveLength(1);
    });

    it('hide is safe to repeat; delete of a deleted comment is skipped', async () => {
      const comment = await insertComment(owner.workspaceId, ownerPage);
      await executor.execute(auto(comment.id, 'HIDE'));
      await executor.execute(auto(comment.id, 'HIDE'));
      expect(graph.hideComment).toHaveBeenCalledTimes(2);
      expect((await commentRow(comment.id)).status).toBe('HIDDEN');

      await executor.execute(auto(comment.id, 'DELETE'));
      await expect(
        executor.execute(auto(comment.id, 'DELETE')),
      ).resolves.toEqual({ outcome: 'skipped', reason: 'comment_deleted' });
      await expect(executor.execute(autoReply(comment.id))).resolves.toEqual({
        outcome: 'skipped',
        reason: 'comment_deleted',
      });
      expect(graph.deleteComment).toHaveBeenCalledTimes(1);
      expect(graph.replyToComment).not.toHaveBeenCalled();
      expect(await actionsOf(comment.id)).toHaveLength(3);
    });

    it('DELETE answered not_found = already gone: SUCCEEDED + DELETED', async () => {
      const comment = await insertComment(owner.workspaceId, ownerPage);
      graph.deleteComment.mockRejectedValue(
        new MetaGraphError('not_found', 'Meta Graph 400 (#100/33): gone', {
          status: 400,
          code: 100,
          subcode: 33,
        }),
      );
      await expect(
        executor.execute(auto(comment.id, 'DELETE')),
      ).resolves.toMatchObject({ outcome: 'succeeded', alreadyGone: true });
      expect((await actionsOf(comment.id))[0]).toMatchObject({
        state: 'SUCCEEDED',
        errorKind: null,
      });
      expect((await commentRow(comment.id)).status).toBe('DELETED');
    });

    it('a failed hide leaves the comment as it was (FAILED row, retryable)', async () => {
      const comment = await insertComment(owner.workspaceId, ownerPage);
      graph.hideComment.mockRejectedValue(
        new MetaGraphError('transient', 'Meta Graph 500', { status: 500 }),
      );
      await expect(
        executor.execute(auto(comment.id, 'HIDE')),
      ).resolves.toMatchObject({
        outcome: 'failed',
        errorKind: 'transient',
        retryable: true,
        connectionMarked: false,
      });
      expect((await actionsOf(comment.id))[0]).toMatchObject({
        state: 'FAILED',
        errorKind: 'transient',
      });
      expect((await commentRow(comment.id)).status).toBe('VISIBLE');
    });
  });

  describe('human override (D10/D11)', () => {
    it('a member action logs the user and stamps the comment; the AI then never touches it', async () => {
      const comment = await insertComment(owner.workspaceId, ownerPage);
      await expect(
        executor.execute({
          workspaceId: owner.workspaceId,
          commentId: comment.id,
          action: 'HIDE',
          source: 'USER',
          userId: owner.id,
        }),
      ).resolves.toMatchObject({ outcome: 'succeeded' });
      const stamped = await commentRow(comment.id);
      expect(stamped.overriddenAt).toBeInstanceOf(Date);
      expect(stamped.status).toBe('HIDDEN');
      expect((await actionsOf(comment.id))[0]).toMatchObject({
        source: 'USER',
        userId: owner.id,
        state: 'SUCCEEDED',
      });

      for (const input of [
        auto(comment.id, 'UNHIDE'),
        auto(comment.id, 'DELETE'),
        autoReply(comment.id),
      ]) {
        await expect(executor.execute(input)).resolves.toEqual({
          outcome: 'skipped',
          reason: 'human_override',
        });
      }
      expect(graph.unhideComment).not.toHaveBeenCalled();
      expect(await actionsOf(comment.id)).toHaveLength(1);
      // The first stamp is kept.
      await executor.execute({
        workspaceId: owner.workspaceId,
        commentId: comment.id,
        action: 'UNHIDE',
        source: 'USER',
        userId: owner.id,
      });
      expect((await commentRow(comment.id)).overriddenAt).toEqual(
        stamped.overriddenAt,
      );
    });
  });

  describe('skip rules', () => {
    it('orphaned comment, Page off and connection not ACTIVE → skipped, no Graph call, no row', async () => {
      const orphan = await insertComment(owner.workspaceId, null);
      await expect(executor.execute(auto(orphan.id, 'HIDE'))).resolves.toEqual({
        outcome: 'skipped',
        reason: 'page_disconnected',
      });

      const offPage = await insertPage(owner.workspaceId, false);
      const onOffPage = await insertComment(owner.workspaceId, offPage);
      await expect(
        executor.execute(auto(onOffPage.id, 'HIDE')),
      ).resolves.toEqual({ outcome: 'skipped', reason: 'page_inactive' });

      const comment = await insertComment(owner.workspaceId, ownerPage);
      await db()
        .update(metaConnections)
        .set({ status: 'NEEDS_REAUTH' })
        .where(eq(metaConnections.workspaceId, owner.workspaceId));
      try {
        await expect(
          executor.execute(auto(comment.id, 'HIDE')),
        ).resolves.toEqual({
          outcome: 'skipped',
          reason: 'connection_inactive',
        });
      } finally {
        await db()
          .update(metaConnections)
          .set({ status: 'ACTIVE' })
          .where(eq(metaConnections.workspaceId, owner.workspaceId));
      }
      expect(graphCalls()).toBe(0);
      for (const id of [orphan.id, onOffPage.id, comment.id]) {
        expect(await actionsOf(id)).toHaveLength(0);
      }
    });

    it('token_invalid → FAILED row + connection NEEDS_REAUTH', async () => {
      const comment = await insertComment(other.workspaceId, otherPage);
      graph.hideComment.mockRejectedValue(
        new MetaGraphError('token_invalid', 'Meta Graph 400 (#190): expired', {
          status: 400,
          code: 190,
        }),
      );
      try {
        await expect(
          executor.execute(auto(comment.id, 'HIDE', other.workspaceId)),
        ).resolves.toMatchObject({
          outcome: 'failed',
          errorKind: 'token_invalid',
          retryable: false,
          connectionMarked: true,
        });
        const connection = await connectionOf(other.workspaceId);
        expect(connection.status).toBe('NEEDS_REAUTH');
        expect(connection.statusChangedAt.getTime()).toBeGreaterThan(
          LONG_AGO.getTime(),
        );
        expect((await actionsOf(comment.id))[0]).toMatchObject({
          state: 'FAILED',
          errorKind: 'token_invalid',
        });
        // Owner's connection is untouched.
        expect((await connectionOf(owner.workspaceId)).status).toBe('ACTIVE');
      } finally {
        await db()
          .update(metaConnections)
          .set({ status: 'ACTIVE', statusChangedAt: LONG_AGO })
          .where(eq(metaConnections.workspaceId, other.workspaceId));
      }
    });
  });

  describe('tenant isolation', () => {
    it("another workspace's comment id → comment_not_found, no Graph call, nothing written", async () => {
      const comment = await insertComment(owner.workspaceId, ownerPage);
      for (const input of [
        auto(comment.id, 'HIDE', other.workspaceId),
        auto(comment.id, 'DELETE', other.workspaceId),
        { ...autoReply(comment.id), workspaceId: other.workspaceId },
        {
          workspaceId: other.workspaceId,
          commentId: comment.id,
          action: 'UNHIDE' as const,
          source: 'USER' as const,
          userId: other.id,
        },
        auto('not-a-uuid', 'HIDE'),
      ]) {
        await expect(executor.execute(input)).resolves.toEqual({
          outcome: 'skipped',
          reason: 'comment_not_found',
        });
      }
      expect(graphCalls()).toBe(0);
      expect(await actionsOf(comment.id)).toHaveLength(0);
      const stored = await commentRow(comment.id);
      expect(stored.status).toBe('VISIBLE');
      expect(stored.overriddenAt).toBeNull();
    });
  });

  /**
   * Gate check (2): the exact Graph requests (method, URL, form body / query) for hide, unhide,
   * delete and reply on FB + IG, through the executor, the real `MetaGraphClient` and a stubbed
   * `fetch` that rejects any other request.
   */
  describe('exact Graph payloads (real client, stubbed fetch)', () => {
    const CONFIG: MetaAppConfig = {
      appId: '1234567890',
      appSecret: 'e2e-app-secret-0123456789abcdef',
      loginConfigId: '987654321',
      redirectUri: 'http://app.localhost:5174/api/meta/oauth/callback',
      graphApiVersion: 'v26.0',
    };
    const fetchMock = vi.fn<typeof fetch>();
    let realExecutor: ModerationActionExecutor;

    beforeAll(() => {
      realExecutor = new ModerationActionExecutor(
        db(),
        new MetaGraphClient(CONFIG),
        cipher,
      );
      vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    });
    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());
    afterAll(() => vi.restoreAllMocks());

    const proof = () =>
      createHmac('sha256', CONFIG.appSecret)
        .update(ownerPage.token)
        .digest('hex');

    /** Answers only the one expected request; anything else fails the spec. */
    function expectRequest(
      method: string,
      path: string,
      params: Record<string, string>,
      answer: unknown,
    ) {
      fetchMock.mockImplementation(async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const body = init?.body;
        if (method === 'POST') expect(typeof body).toBe('string');
        const sent =
          method === 'POST'
            ? Object.fromEntries(new URLSearchParams(body as string))
            : Object.fromEntries(url.searchParams);
        expect(init?.method).toBe(method);
        expect(url.origin + url.pathname).toBe(
          `https://graph.facebook.com/v26.0/${path}`,
        );
        if (method === 'POST') {
          expect(url.search).toBe('');
          expect(init?.headers).toMatchObject({
            'Content-Type': 'application/x-www-form-urlencoded',
          });
        } else {
          expect(init?.body).toBeUndefined();
        }
        expect(sent).toEqual({
          ...params,
          access_token: ownerPage.token,
          appsecret_proof: proof(),
        });
        return new Response(JSON.stringify(answer), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
    }

    it.each([
      ['HIDE', 'FACEBOOK', 'POST', '', { is_hidden: 'true' }],
      ['UNHIDE', 'FACEBOOK', 'POST', '', { is_hidden: 'false' }],
      ['HIDE', 'INSTAGRAM', 'POST', '', { hide: 'true' }],
      ['UNHIDE', 'INSTAGRAM', 'POST', '', { hide: 'false' }],
      ['DELETE', 'FACEBOOK', 'DELETE', '', {}],
      ['DELETE', 'INSTAGRAM', 'DELETE', '', {}],
    ] as const)(
      '%s on %s = %s /{comment-id}%s %j',
      async (action, platform, method, suffix, params) => {
        const comment = await insertComment(
          owner.workspaceId,
          ownerPage,
          platform,
        );
        expectRequest(method, `${comment.metaCommentId}${suffix}`, params, {
          success: true,
        });
        await expect(
          realExecutor.execute(auto(comment.id, action)),
        ).resolves.toMatchObject({ outcome: 'succeeded' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ['FACEBOOK', 'comments', '2020000000000002_3030000000000004'],
      ['INSTAGRAM', 'replies', '17890000000000077'],
    ] as const)(
      'REPLY on %s = POST /{comment-id}/%s message=…',
      async (platform, edge, replyId) => {
        const comment = await insertComment(
          owner.workspaceId,
          ownerPage,
          platform,
        );
        expectRequest(
          'POST',
          `${comment.metaCommentId}/${edge}`,
          { message: REPLY_TEXT },
          { id: replyId },
        );
        await expect(
          realExecutor.execute(autoReply(comment.id)),
        ).resolves.toMatchObject({
          outcome: 'succeeded',
          replyCommentId: replyId,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [row] = await db()
          .select()
          .from(moderationActions)
          .where(
            and(
              eq(moderationActions.commentId, comment.id),
              eq(moderationActions.action, 'REPLY'),
            ),
          );
        expect(row?.replyCommentId).toBe(replyId);
      },
    );

    it('Graph #100/33 on DELETE through the real client = already gone', async () => {
      const comment = await insertComment(owner.workspaceId, ownerPage);
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: `Unsupported delete request. Object with ID '${comment.metaCommentId}' does not exist`,
              type: 'GraphMethodException',
              code: 100,
              error_subcode: 33,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await expect(
        realExecutor.execute(auto(comment.id, 'DELETE')),
      ).resolves.toMatchObject({ outcome: 'succeeded', alreadyGone: true });
      expect((await commentRow(comment.id)).status).toBe('DELETED');
    });
  });
});
