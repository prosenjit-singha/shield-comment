import { Logger, type INestApplication } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import type { Database } from '../src/db/database.js';
import {
  type CommentPlatform,
  type MetaConnectionStatus,
  metaConnections,
  postContexts,
  socialPages,
  workspaces,
} from '../src/db/schema/index.js';
import { deleteWorkspaceMetaData } from '../src/meta-callbacks/meta-callbacks.queries.js';
import { deleteWorkspacePages } from '../src/meta/meta-disconnect.queries.js';
import { MetaGraphClient } from '../src/meta/meta-graph.client.js';
import { MetaGraphError } from '../src/meta/meta-graph.errors.js';
import { POST_CONTEXT_TTL_MS } from '../src/moderation/moderation.constants.js';
import {
  type PostContextComment,
  PostContextService,
} from '../src/moderation/post-context.service.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import {
  FAKE_POST_CAPTION,
  fakePostContextGraph,
} from './utils/fake-meta-graph.js';

const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

/**
 * M5-T10: `PostContextService` + the `post_contexts` cache (migration 0017) against real Postgres
 * and the real token cipher (decision D8). `MetaGraphClient` is the strict fake: only
 * `getPostCaption` answers, any other Graph call fails the spec.
 */
describe('Post context (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  let service: PostContextService;
  const graph = fakePostContextGraph();
  let owner: Actor;
  let other: Actor;
  let ownerPage: { id: string; pageId: string; token: string };
  let otherPage: { id: string; pageId: string; token: string };

  const db = (): Database => actors.db;
  const base = `7${Date.now()}`;
  let seq = 10;
  const next = () => `${base}${++seq}`;

  async function insertConnection(actor: Actor, status: MetaConnectionStatus) {
    const fbUserId = next();
    const [row] = await db()
      .insert(metaConnections)
      .values({
        workspaceId: actor.workspaceId,
        facebookUserId: fbUserId,
        encryptedUserAccessToken: cipher.encrypt(
          `EAAuser${fbUserId}`,
          tokenCipherContext('meta_user_token', actor.workspaceId, fbUserId),
        ),
        grantedScopes: ['pages_read_engagement'],
        status,
        statusChangedAt: LONG_AGO,
      })
      .returning();
    return { id: row!.id, facebookUserId: fbUserId };
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
        encryptedPageAccessToken: cipher.encrypt(
          token,
          tokenCipherContext('meta_page_token', workspaceId, pageId),
        ),
        isActive,
      })
      .returning();
    return { id: row!.id, pageId, token };
  }

  const fbComment = (
    workspaceId: string,
    page: { id: string; pageId: string } | null,
    postId = `${page?.pageId ?? next()}_${next()}`,
    platform: CommentPlatform = 'FACEBOOK',
  ): PostContextComment => ({
    workspaceId,
    socialPageId: page?.id ?? null,
    platform,
    postId,
  });

  const cacheRows = (workspaceId: string) =>
    db()
      .select()
      .from(postContexts)
      .where(eq(postContexts.workspaceId, workspaceId));
  const connectionStatus = async (workspaceId: string) =>
    (
      await db()
        .select({ status: metaConnections.status })
        .from(metaConnections)
        .where(eq(metaConnections.workspaceId, workspaceId))
    )[0]?.status;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(MetaGraphClient).useValue(graph),
    );
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    service = app.get(PostContextService);
    owner = await actors.signUp('m5t10-owner');
    other = await actors.signUp('m5t10-other');
    await insertConnection(owner, 'ACTIVE');
    await insertConnection(other, 'ACTIVE');
    ownerPage = await insertPage(owner.workspaceId);
    otherPage = await insertPage(other.workspaceId);
  });

  beforeEach(() => {
    graph.getPostCaption.mockReset().mockResolvedValue(FAKE_POST_CAPTION);
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('levels', () => {
    it('comment_only → nothing, no Graph', async () => {
      await expect(
        service.forComment(
          fbComment(owner.workspaceId, ownerPage),
          'comment_only',
        ),
      ).resolves.toEqual({ pageName: null, postCaption: null });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });

    it('page_name → social_pages.page_name, no Graph, no cache row', async () => {
      const comment = fbComment(owner.workspaceId, ownerPage);
      await expect(service.forComment(comment, 'page_name')).resolves.toEqual({
        pageName: `Shop ${ownerPage.pageId}`,
        postCaption: null,
      });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
      const rows = await cacheRows(owner.workspaceId);
      expect(rows.find((r) => r.postId === comment.postId)).toBeUndefined();
    });

    it('orphaned comment (Page disconnected) → nothing', async () => {
      await expect(
        service.forComment(fbComment(owner.workspaceId, null), 'post_caption'),
      ).resolves.toEqual({ pageName: null, postCaption: null });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });
  });

  describe('post_caption cache', () => {
    it('miss → one Graph call with the decrypted Page token, then hits use the row', async () => {
      const comment = fbComment(owner.workspaceId, ownerPage);
      const t0 = new Date();
      await expect(
        service.forComment(comment, 'post_caption', () => t0),
      ).resolves.toEqual({
        pageName: `Shop ${ownerPage.pageId}`,
        postCaption: FAKE_POST_CAPTION,
      });
      expect(graph.getPostCaption).toHaveBeenCalledExactlyOnceWith(
        'FACEBOOK',
        comment.postId,
        ownerPage.token,
      );
      const [row] = (await cacheRows(owner.workspaceId)).filter(
        (r) => r.postId === comment.postId,
      );
      expect(row).toMatchObject({
        socialPageId: ownerPage.id,
        platform: 'FACEBOOK',
        caption: FAKE_POST_CAPTION,
        fetchedAt: t0,
      });

      // Another comment on the same post, 23 h later: cache hit, no Graph call.
      graph.getPostCaption.mockClear();
      const later = new Date(t0.getTime() + POST_CONTEXT_TTL_MS - 60_000);
      await expect(
        service.forComment(comment, 'post_caption', () => later),
      ).resolves.toMatchObject({ postCaption: FAKE_POST_CAPTION });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });

    it('refreshed after 24 h: Graph again, row updated in place', async () => {
      const comment = fbComment(owner.workspaceId, ownerPage);
      const t0 = new Date();
      await service.forComment(comment, 'post_caption', () => t0);
      graph.getPostCaption.mockReset().mockResolvedValue('Updated caption');
      const t1 = new Date(t0.getTime() + POST_CONTEXT_TTL_MS + 1);
      await expect(
        service.forComment(comment, 'post_caption', () => t1),
      ).resolves.toMatchObject({ postCaption: 'Updated caption' });
      expect(graph.getPostCaption).toHaveBeenCalledTimes(1);
      const rows = (await cacheRows(owner.workspaceId)).filter(
        (r) => r.postId === comment.postId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        caption: 'Updated caption',
        fetchedAt: t1,
      });
    });

    it('IG media: platform INSTAGRAM, its own row', async () => {
      const media = next();
      const comment = fbComment(
        owner.workspaceId,
        ownerPage,
        media,
        'INSTAGRAM',
      );
      graph.getPostCaption.mockResolvedValue(null);
      await expect(
        service.forComment(comment, 'post_caption'),
      ).resolves.toMatchObject({ postCaption: null });
      expect(graph.getPostCaption).toHaveBeenCalledWith(
        'INSTAGRAM',
        media,
        ownerPage.token,
      );
      const rows = (await cacheRows(owner.workspaceId)).filter(
        (r) => r.postId === media,
      );
      expect(rows).toEqual([
        expect.objectContaining({ platform: 'INSTAGRAM', caption: null }),
      ]);
      // "No text" is cached too: no second call.
      await service.forComment(comment, 'post_caption');
      expect(graph.getPostCaption).toHaveBeenCalledTimes(1);
    });

    it('a Graph failure → null, nothing cached; the next call tries again', async () => {
      const comment = fbComment(owner.workspaceId, ownerPage);
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      graph.getPostCaption.mockRejectedValueOnce(
        new MetaGraphError('rate_limited', 'Meta Graph 400', { code: 4 }),
      );
      await expect(
        service.forComment(comment, 'post_caption'),
      ).resolves.toMatchObject({ postCaption: null });
      expect(
        (await cacheRows(owner.workspaceId)).some(
          (r) => r.postId === comment.postId,
        ),
      ).toBe(false);
      await expect(
        service.forComment(comment, 'post_caption'),
      ).resolves.toMatchObject({ postCaption: FAKE_POST_CAPTION });
      expect(graph.getPostCaption).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('Page off → Page name only, no Graph', async () => {
      const page = await insertPage(owner.workspaceId, false);
      await expect(
        service.forComment(fbComment(owner.workspaceId, page), 'post_caption'),
      ).resolves.toEqual({
        pageName: `Shop ${page.pageId}`,
        postCaption: null,
      });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });

    it('token_invalid → null + connection NEEDS_REAUTH; afterwards no Graph call', async () => {
      const actor = await actors.signUp('m5t10-reauth');
      await insertConnection(actor, 'ACTIVE');
      const page = await insertPage(actor.workspaceId);
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      graph.getPostCaption.mockRejectedValueOnce(
        new MetaGraphError('token_invalid', 'Meta Graph 400', { code: 190 }),
      );
      const comment = fbComment(actor.workspaceId, page);
      await expect(
        service.forComment(comment, 'post_caption'),
      ).resolves.toMatchObject({ postCaption: null });
      expect(await connectionStatus(actor.workspaceId)).toBe('NEEDS_REAUTH');
      await expect(
        service.forComment(comment, 'post_caption'),
      ).resolves.toEqual({
        pageName: `Shop ${page.pageId}`,
        postCaption: null,
      });
      expect(graph.getPostCaption).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe('tenant isolation', () => {
    it("another workspace's Page id gives nothing (no Graph with its token)", async () => {
      await expect(
        service.forComment(
          fbComment(owner.workspaceId, otherPage),
          'post_caption',
        ),
      ).resolves.toEqual({ pageName: null, postCaption: null });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });

    it("the same post id in two workspaces: separate rows, never the other's caption", async () => {
      const postId = `${ownerPage.pageId}_${next()}`;
      graph.getPostCaption.mockResolvedValueOnce('Owner caption');
      await service.forComment(
        fbComment(owner.workspaceId, ownerPage, postId),
        'post_caption',
      );
      graph.getPostCaption.mockResolvedValueOnce('Other caption');
      await expect(
        service.forComment(
          fbComment(other.workspaceId, otherPage, postId),
          'post_caption',
        ),
      ).resolves.toMatchObject({ postCaption: 'Other caption' });
      expect(graph.getPostCaption).toHaveBeenLastCalledWith(
        'FACEBOOK',
        postId,
        otherPage.token,
      );
      const rows = await db()
        .select()
        .from(postContexts)
        .where(eq(postContexts.postId, postId));
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workspaceId: owner.workspaceId,
            caption: 'Owner caption',
          }),
          expect.objectContaining({
            workspaceId: other.workspaceId,
            caption: 'Other caption',
          }),
        ]),
      );
    });
  });

  describe('schema (migration 0017)', () => {
    const row = (patch: Partial<typeof postContexts.$inferInsert> = {}) => ({
      workspaceId: owner.workspaceId,
      socialPageId: ownerPage.id,
      platform: 'FACEBOOK' as const,
      postId: `${ownerPage.pageId}_${next()}`,
      caption: 'x',
      fetchedAt: new Date(),
      ...patch,
    });
    const rejects = (patch: Partial<typeof postContexts.$inferInsert>) =>
      expect(db().insert(postContexts).values(row(patch))).rejects.toThrow();

    it('checks platform, post id format and caption length 1–2,000', async () => {
      await rejects({ platform: 'TIKTOK' as CommentPlatform });
      await rejects({ postId: 'abc' });
      await rejects({ postId: '1_2_3_4' });
      await rejects({ caption: '' });
      await rejects({ caption: 'ক'.repeat(2001) });
      await expect(
        db()
          .insert(postContexts)
          .values(row({ caption: 'ক'.repeat(2000) })),
      ).resolves.toBeDefined();
      await expect(
        db()
          .insert(postContexts)
          .values(row({ caption: null })),
      ).resolves.toBeDefined();
    });

    it('key = workspace + platform + post id', async () => {
      const first = row();
      await db().insert(postContexts).values(first);
      await expect(
        db()
          .insert(postContexts)
          .values({ ...first }),
      ).rejects.toThrow();
      await expect(
        db()
          .insert(postContexts)
          .values({ ...first, platform: 'INSTAGRAM' }),
      ).resolves.toBeDefined();
    });

    it('workspace FK restrict; Page FK cascade', async () => {
      const actor = await actors.signUp('m5t10-fk');
      const page = await insertPage(actor.workspaceId, false);
      await db()
        .insert(postContexts)
        .values(row({ workspaceId: actor.workspaceId, socialPageId: page.id }));
      await expect(
        db().delete(workspaces).where(eq(workspaces.id, actor.workspaceId)),
      ).rejects.toThrow();
      await db().delete(socialPages).where(eq(socialPages.id, page.id));
      expect(await cacheRows(actor.workspaceId)).toEqual([]);
    });

    it('migration 0017 is applied', async () => {
      const result = await db().execute<{ name: string }>(
        sql`select to_regclass('public.post_contexts')::text as name`,
      );
      expect(result.rows[0]?.name).toBe('post_contexts');
    });
  });

  describe('delete paths', () => {
    async function seeded() {
      const actor = await actors.signUp('m5t10-del');
      const connection = await insertConnection(actor, 'ACTIVE');
      const page = await insertPage(actor.workspaceId);
      await service.forComment(
        fbComment(actor.workspaceId, page),
        'post_caption',
      );
      expect(await cacheRows(actor.workspaceId)).toHaveLength(1);
      return { actor, connection, page };
    }

    it('disconnect (deleteWorkspacePages) removes the Pages’ cache rows only', async () => {
      const { actor, page } = await seeded();
      const before = (await cacheRows(owner.workspaceId)).length;
      await db().transaction((tx) =>
        deleteWorkspacePages(tx, actor.workspaceId, [page.id]),
      );
      expect(await cacheRows(actor.workspaceId)).toEqual([]);
      expect(await cacheRows(owner.workspaceId)).toHaveLength(before);
    });

    it('Data Deletion (deleteWorkspaceMetaData) removes the cache rows', async () => {
      const { actor, connection, page } = await seeded();
      await db().transaction((tx) =>
        deleteWorkspaceMetaData(tx, {
          workspaceId: actor.workspaceId,
          connectionId: connection.id,
          pageIds: [page.id],
          facebookUserId: connection.facebookUserId,
        }),
      );
      expect(await cacheRows(actor.workspaceId)).toEqual([]);
      expect(
        await db()
          .select()
          .from(socialPages)
          .where(
            and(
              eq(socialPages.workspaceId, actor.workspaceId),
              eq(socialPages.id, page.id),
            ),
          ),
      ).toEqual([]);
    });
  });
});
