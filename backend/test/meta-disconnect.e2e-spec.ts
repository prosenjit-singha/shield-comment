import type { INestApplication } from '@nestjs/common';
import type { Job } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import {
  comments,
  dailyCommentStats,
  metaConnections,
  socialPages,
  webhookEvents,
} from '../src/db/schema/index.js';
import {
  META_CALLBACKS_CONFIG,
  type MetaCallbacksConfig,
} from '../src/meta-callbacks/meta-callbacks.config.js';
import { signMetaSignedRequest } from '../src/meta-callbacks/meta-signed-request.js';
import {
  MetaTokenCheckProcessor,
  type MetaTokenCheckResult,
} from '../src/meta-callbacks/meta-token-check.processor.js';
import {
  MetaGraphClient,
  type MetaPageAccount,
} from '../src/meta/meta-graph.client.js';
import { MetaGraphError } from '../src/meta/meta-graph.errors.js';
import { MetaOAuthStateStore } from '../src/meta/meta-oauth-state.store.js';
import { QUEUE_NAMES } from '../src/queue/queue.constants.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { fakePageSubscriptionGraph } from './utils/fake-meta-graph.js';
import { type FakeJob, fakeQueue, type FakeQueue } from './utils/fake-queue.js';
import { MemoryMetaOAuthStateStore } from './utils/memory-oauth-state-store.js';

const SECRET = 'e2e-meta-app-secret-0123456789abcdef';
const CLIENT = 'http://app.localhost:5174';

/** Every response's headers and body, to prove no token, ciphertext or FB user id leaks. */
const seen: string[] = [];
const record = (res: request.Response) => {
  seen.push(JSON.stringify({ h: res.headers, b: res.body, t: res.text }));
  return res;
};

/**
 * M4-T9: `DELETE /api/workspaces/:workspaceId/meta/connection` (Module 4 D7 + decision 2026-11-19
 * "Keep FB user id on comments"), end to end: connect through the real OAuth callback (fake
 * Graph), disconnect, then the freed Page claim and a later Data Deletion. Real Postgres + real
 * token cipher; `MetaGraphClient` is the strict fake (unexpected Graph calls throw).
 */
describe('Meta disconnect (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  let queue: FakeQueue;
  let processor: MetaTokenCheckProcessor;
  const graph = fakePageSubscriptionGraph();
  const states = new MemoryMetaOAuthStateStore();
  const callbacksConfig: MetaCallbacksConfig = {
    appSecret: SECRET,
    clientAppUrl: CLIENT,
  };
  let owner: Actor;
  let other: Actor;
  let moderator: Actor;
  let outsider: Actor;
  let superAdmin: Actor;

  const http = () => request(app.getHttpServer());
  const db = () => actors.db;
  const base = `6${Date.now()}`;
  const FB_OWNER = `${base}01`;
  const FB_OTHER = `${base}02`;
  const PAGE_A = `${base}11`;
  const PAGE_B = `${base}12`;
  const PAGE_C = `${base}13`;
  const IG_A = `${base}91`;
  let seq = 0;
  /** Plaintext tokens handed out by the fake Graph (must never appear in a response). */
  const tokens: string[] = [];

  const disconnectPath = (workspaceId: string) =>
    `/api/workspaces/${workspaceId}/meta/connection`;
  const disconnect = (cookie: string, workspaceId: string) =>
    http().delete(disconnectPath(workspaceId)).set('Cookie', cookie);

  const fbPage = (
    id: string,
    name: string,
    instagram: MetaPageAccount['instagram'] = null,
  ): MetaPageAccount => {
    seq += 1;
    const accessToken = `EAApage${seq}x${id}`;
    tokens.push(accessToken);
    return { id, name, accessToken, instagram };
  };

  /** Full connect round trip (OAuth URL → callback with a fake Graph); returns the redirect. */
  async function connect(
    actor: Actor,
    fbUserId: string,
    pages: MetaPageAccount[],
  ): Promise<{ location: string; userToken: string }> {
    const start = record(
      await http()
        .get(`/api/workspaces/${actor.workspaceId}/meta/oauth/url`)
        .set('Cookie', actor.cookie)
        .expect(200),
    );
    const state = new URL(start.body.url as string).searchParams.get('state')!;
    seq += 1;
    const userToken = `EAAlong${seq}x${base}`;
    tokens.push(userToken, `EAAshort${seq}x${base}`);
    graph.exchangeCode.mockResolvedValueOnce({
      accessToken: `EAAshort${seq}x${base}`,
      expiresAt: null,
    });
    graph.exchangeForLongLivedToken.mockResolvedValueOnce({
      accessToken: userToken,
      expiresAt: new Date('2027-01-17T00:00:00.000Z'),
    });
    graph.getMe.mockResolvedValueOnce({ id: fbUserId, name: 'Owner' });
    graph.getPermissions.mockResolvedValueOnce({
      granted: ['pages_show_list'],
      declined: [],
    });
    graph.getPages.mockResolvedValueOnce(pages);
    const res = record(
      await http()
        .get('/api/meta/oauth/callback')
        .query({ code: `AQD-code-${seq}`, state })
        .set('Cookie', actor.cookie),
    );
    expect(res.status).toBe(302);
    return { location: res.headers['location'] as string, userToken };
  }

  const pagesOf = (workspaceId: string) =>
    db()
      .select()
      .from(socialPages)
      .where(eq(socialPages.workspaceId, workspaceId))
      .orderBy(asc(socialPages.pageId));
  const pageRow = async (workspaceId: string, pageId: string) =>
    (await pagesOf(workspaceId)).find((row) => row.pageId === pageId)!;
  const connectionOf = async (workspaceId: string) =>
    (
      await db()
        .select()
        .from(metaConnections)
        .where(eq(metaConnections.workspaceId, workspaceId))
    )[0];
  const commentsOf = (workspaceId: string) =>
    db()
      .select()
      .from(comments)
      .where(eq(comments.workspaceId, workspaceId))
      .orderBy(asc(comments.commentId));
  const eventsOf = (workspaceId: string) =>
    db()
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.workspaceId, workspaceId));
  const statsOf = (workspaceId: string) =>
    db()
      .select()
      .from(dailyCommentStats)
      .where(eq(dailyCommentStats.workspaceId, workspaceId))
      .orderBy(asc(dailyCommentStats.pageId));

  /** One comment on a Page (+ its webhook event + a daily stats row), as the worker stores them. */
  async function insertComment(
    workspaceId: string,
    page: { id: string; pageId: string },
  ) {
    seq += 1;
    const commentId = `${page.pageId}_${base}${seq}`;
    await db()
      .insert(comments)
      .values({
        commentId,
        workspaceId,
        socialPageId: page.id,
        platform: 'FACEBOOK',
        postId: `${page.pageId}_1`,
        authorId: '42',
        authorName: 'Rahim',
        message: 'bKash 017',
        rawPayload: { message: 'bKash 017' },
      });
    await db()
      .insert(webhookEvents)
      .values({
        eventId: `FACEBOOK:${commentId}:add`,
        workspaceId,
        payloadHash: 'a'.repeat(64),
        processedAt: new Date(),
      });
    await db()
      .insert(dailyCommentStats)
      .values({
        workspaceId,
        pageId: page.pageId,
        platform: 'FACEBOOK',
        day: '2026-11-18',
        receivedCount: 1,
      })
      .onConflictDoNothing();
    return commentId;
  }

  const decryptPage = (stored: string, workspaceId: string, pageId: string) =>
    cipher.decrypt(
      stored,
      tokenCipherContext('meta_page_token', workspaceId, pageId),
    );

  const runJob = (job: FakeJob) =>
    processor.process(job as unknown as Job<unknown, MetaTokenCheckResult>);

  let ownerUserToken: string;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(MetaGraphClient)
        .useValue(graph)
        .overrideProvider(MetaOAuthStateStore)
        .useValue(states)
        .overrideProvider(META_CALLBACKS_CONFIG)
        .useValue(callbacksConfig),
    );
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    queue = fakeQueue(app, QUEUE_NAMES.metaTokenCheck);
    processor = app.get(MetaTokenCheckProcessor);
    graph.buildLoginUrl.mockImplementation(
      (state: string) =>
        `https://www.facebook.com/v26.0/dialog/oauth?client_id=1&state=${state}`,
    );
    owner = await actors.signUp('m4t9-owner');
    other = await actors.signUp('m4t9-other');
    moderator = await actors.signUp('m4t9-mod');
    outsider = await actors.signUp('m4t9-outsider');
    superAdmin = await actors.signUpSuperAdmin('m4t9-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    for (const id of [FB_OWNER, FB_OTHER]) actors.trackFacebookUser(id);

    // Owner: Pages A (+ IG) and B, A switched on (subscribe), one comment on each.
    const connected = await connect(owner, FB_OWNER, [
      fbPage(PAGE_A, 'Shop A', { id: IG_A, username: 'shop.a' }),
      fbPage(PAGE_B, 'Shop B'),
    ]);
    expect(connected.location).toBe(`${CLIENT}/onboarding?meta=connected`);
    ownerUserToken = connected.userToken;
    const a = await pageRow(owner.workspaceId, PAGE_A);
    record(
      await http()
        .patch(`/api/workspaces/${owner.workspaceId}/pages/${a.id}/toggle`)
        .set('Cookie', owner.cookie)
        .send({ isActive: true })
        .expect(200),
    );
    expect(graph.subscribePageApp).toHaveBeenCalledTimes(1);
    await insertComment(owner.workspaceId, a);
    await insertComment(
      owner.workspaceId,
      await pageRow(owner.workspaceId, PAGE_B),
    );

    // Other workspace: its own FB user + Page C, one comment.
    await connect(other, FB_OTHER, [fbPage(PAGE_C, 'Shop C')]);
    await insertComment(
      other.workspaceId,
      await pageRow(other.workspaceId, PAGE_C),
    );
  });

  beforeEach(() => {
    graph.unsubscribePageApp.mockReset().mockResolvedValue(undefined);
    graph.revokePermissions.mockReset().mockResolvedValue(undefined);
    graph.subscribePageApp.mockClear();
    graph.enabled = true;
    queue.reset();
  });

  afterAll(async () => {
    const all = seen.join('\n');
    for (const token of tokens) expect(all).not.toContain(token);
    expect(all).not.toMatch(/"v1:e2e:/);
    // The disconnect stamp (FB user id) is never returned either.
    expect(all).not.toContain(FB_OWNER);
    await actors?.cleanup();
    await app?.close();
  });

  const noGraphCleanup = () => {
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
    expect(graph.revokePermissions).not.toHaveBeenCalled();
  };

  it('401 without a session, 403 moderator, 403 impersonated, 404 non-member / other workspace: nothing deleted, no Graph call', async () => {
    record(await http().delete(disconnectPath(owner.workspaceId)).expect(401));

    const modCookie = await actors.signIn(moderator.email);
    await actors.patchStoredSession(modCookie, {
      activeOrganizationId: owner.workspaceId,
    });
    record(await disconnect(modCookie, owner.workspaceId).expect(403));

    const impersonated = await actors.signIn(owner.email);
    await actors.patchStoredSession(impersonated, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: owner.workspaceId,
    });
    const res = record(
      await disconnect(impersonated, owner.workspaceId).expect(403),
    );
    expect(res.body.message).toMatch(/impersonat/i);

    record(await disconnect(outsider.cookie, owner.workspaceId).expect(404));
    // Tenant isolation: the owner can't touch another workspace.
    record(await disconnect(owner.cookie, other.workspaceId).expect(404));

    expect(await connectionOf(owner.workspaceId)).toBeDefined();
    expect(await pagesOf(owner.workspaceId)).toHaveLength(2);
    expect(await connectionOf(other.workspaceId)).toBeDefined();
    expect(await pagesOf(other.workspaceId)).toHaveLength(1);
    noGraphCleanup();
  });

  it('before the disconnect, another workspace connecting Page A gets it skipped (claimed)', async () => {
    const { location } = await connect(other, FB_OTHER, [
      fbPage(PAGE_A, 'Shop A', { id: IG_A, username: 'shop.a' }),
      fbPage(PAGE_C, 'Shop C'),
    ]);
    expect(location).toBe(`${CLIENT}/onboarding?meta=connected&skipped=1`);
    expect((await pagesOf(other.workspaceId)).map((p) => p.pageId)).toEqual([
      PAGE_C,
    ]);
  });

  it('disconnect → 200, connection + Pages deleted, comments kept (page null, FB user id stamped), Graph clean-up after commit', async () => {
    const pagesBefore = await pagesOf(owner.workspaceId);
    const statsBefore = await statsOf(owner.workspaceId);
    const eventsBefore = await eventsOf(owner.workspaceId);
    expect(statsBefore).toHaveLength(2);
    const expectedTokens = new Map(
      pagesBefore.map((p) => [
        p.pageId,
        decryptPage(p.encryptedPageAccessToken!, owner.workspaceId, p.pageId),
      ]),
    );
    const committed = async () => {
      // Graph runs after commit: the rows are already gone.
      expect(await connectionOf(owner.workspaceId)).toBeUndefined();
      expect(await pagesOf(owner.workspaceId)).toHaveLength(0);
    };
    graph.unsubscribePageApp.mockImplementation(committed);
    graph.revokePermissions.mockImplementation(committed);

    const res = record(
      await disconnect(owner.cookie, owner.workspaceId).expect(200),
    );
    expect(res.body).toEqual({
      disconnected: true,
      pagesDeleted: 2,
      commentsKept: 2,
    });

    expect(await connectionOf(owner.workspaceId)).toBeUndefined();
    expect(await pagesOf(owner.workspaceId)).toHaveLength(0);
    const kept = await commentsOf(owner.workspaceId);
    expect(kept).toHaveLength(2);
    for (const row of kept) {
      expect(row).toMatchObject({
        socialPageId: null,
        facebookUserId: FB_OWNER,
        message: 'bKash 017',
      });
    }
    expect(await eventsOf(owner.workspaceId)).toHaveLength(eventsBefore.length);
    expect(await statsOf(owner.workspaceId)).toEqual(statsBefore);

    // One unsubscribe per Page with its decrypted Page token, sequential; user token revoked.
    expect(graph.unsubscribePageApp).toHaveBeenCalledTimes(2);
    for (const [pageId, token] of expectedTokens) {
      expect(graph.unsubscribePageApp).toHaveBeenCalledWith(pageId, token);
    }
    expect(graph.revokePermissions).toHaveBeenCalledTimes(1);
    expect(graph.revokePermissions).toHaveBeenCalledWith(ownerUserToken);

    // The pages list now shows no connection.
    const list = record(
      await http()
        .get(`/api/workspaces/${owner.workspaceId}/pages`)
        .set('Cookie', owner.cookie)
        .expect(200),
    );
    expect(list.body).toMatchObject({ items: [], connection: null });

    // Other workspace untouched.
    expect(await connectionOf(other.workspaceId)).toBeDefined();
    expect(await pagesOf(other.workspaceId)).toHaveLength(1);
    expect(await commentsOf(other.workspaceId)).toHaveLength(1);
    expect((await commentsOf(other.workspaceId))[0]!.facebookUserId).toBeNull();
  });

  it('a repeat is idempotent: 200 { disconnected: false }, no Graph call', async () => {
    const res = record(
      await disconnect(owner.cookie, owner.workspaceId).expect(200),
    );
    expect(res.body).toEqual({
      disconnected: false,
      pagesDeleted: 0,
      commentsKept: 0,
    });
    noGraphCleanup();
  });

  it('claim freed: another workspace can now sync Page A (+ its IG account)', async () => {
    const { location } = await connect(other, FB_OTHER, [
      fbPage(PAGE_A, 'Shop A', { id: IG_A, username: 'shop.a' }),
      fbPage(PAGE_C, 'Shop C'),
    ]);
    expect(location).toBe(`${CLIENT}/onboarding?meta=connected`);
    const rows = await pagesOf(other.workspaceId);
    expect(rows.map((p) => [p.pageId, p.igBusinessId])).toEqual([
      [PAGE_A, IG_A],
      [PAGE_C, null],
    ]);
    // The owner's kept comments stay with the owner workspace, unlinked.
    for (const row of await commentsOf(owner.workspaceId)) {
      expect(row.socialPageId).toBeNull();
    }
  });

  it('Graph failures (unsubscribe, permissions) never change the 200', async () => {
    await connect(owner, FB_OWNER, [fbPage(PAGE_B, 'Shop B')]);
    const b = await pageRow(owner.workspaceId, PAGE_B);
    await insertComment(owner.workspaceId, b);
    graph.unsubscribePageApp.mockRejectedValue(
      new MetaGraphError('token_invalid', 'Meta Graph 400 (#190)', {
        status: 400,
        code: 190,
      }),
    );
    graph.revokePermissions.mockRejectedValue(
      new MetaGraphError('transient', 'Meta Graph 500', { status: 500 }),
    );
    const res = record(
      await disconnect(owner.cookie, owner.workspaceId).expect(200),
    );
    expect(res.body).toEqual({
      disconnected: true,
      pagesDeleted: 1,
      commentsKept: 1,
    });
    expect(graph.unsubscribePageApp).toHaveBeenCalledTimes(1);
    expect(graph.revokePermissions).toHaveBeenCalledTimes(1);
    expect(await connectionOf(owner.workspaceId)).toBeUndefined();
    expect(await pagesOf(owner.workspaceId)).toHaveLength(0);
    expect(
      (await commentsOf(owner.workspaceId)).map((c) => c.facebookUserId),
    ).toEqual([FB_OWNER, FB_OWNER, FB_OWNER]);
  });

  it('Meta unset → still disconnects, without any Graph call', async () => {
    await connect(owner, FB_OWNER, [fbPage(PAGE_B, 'Shop B')]);
    graph.enabled = false;
    const res = record(
      await disconnect(owner.cookie, owner.workspaceId).expect(200),
    );
    expect(res.body).toMatchObject({ disconnected: true, pagesDeleted: 1 });
    noGraphCleanup();
    expect(await connectionOf(owner.workspaceId)).toBeUndefined();
  });

  it('Data Deletion after the disconnect deletes the stamped comments + their events, keeps stats, other workspace untouched', async () => {
    const statsBefore = await statsOf(owner.workspaceId);
    const otherComments = await commentsOf(other.workspaceId);
    const otherEvents = await eventsOf(other.workspaceId);
    expect(await commentsOf(owner.workspaceId)).toHaveLength(3);

    const res = await http()
      .post('/api/meta/data-deletion')
      .type('form')
      .send({
        signed_request: signMetaSignedRequest(
          {
            algorithm: 'HMAC-SHA256',
            issued_at: Math.floor(Date.now() / 1000),
            user_id: FB_OWNER,
          },
          SECRET,
        ),
      })
      .expect(200);
    expect(res.body.confirmation_code).toEqual(expect.any(String));
    const [job] = queue.jobs;
    expect(await runJob(job!)).toEqual({
      kind: 'completed',
      connectionsSeen: 0,
      connections: 0,
      pages: 0,
      comments: 3,
      webhookEvents: 3,
    });
    expect(await commentsOf(owner.workspaceId)).toHaveLength(0);
    expect(await eventsOf(owner.workspaceId)).toHaveLength(0);
    expect(await statsOf(owner.workspaceId)).toEqual(statsBefore);

    expect(await commentsOf(other.workspaceId)).toEqual(otherComments);
    expect(await eventsOf(other.workspaceId)).toHaveLength(otherEvents.length);
    expect(await connectionOf(other.workspaceId)).toBeDefined();
    expect(await pagesOf(other.workspaceId)).toHaveLength(2);
  });
});
