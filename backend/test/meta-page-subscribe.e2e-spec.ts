import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import type { Database } from '../src/db/database.js';
import {
  type MetaConnectionStatus,
  metaConnections,
  socialPages,
} from '../src/db/schema/index.js';
import { MetaGraphClient } from '../src/meta/meta-graph.client.js';
import { MetaGraphError } from '../src/meta/meta-graph.errors.js';
import { backfillPageSubscriptions } from '../src/meta/page-subscription.backfill.js';
import { PageSubscriptionService } from '../src/meta/page-subscription.service.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { fakePageSubscriptionGraph } from './utils/fake-meta-graph.js';

/** Every response's headers and body, to prove no token or ciphertext ever leaks. */
const seen: string[] = [];
const record = (res: request.Response) => {
  seen.push(JSON.stringify({ h: res.headers, b: res.body, t: res.text }));
  return res;
};

const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

/**
 * M4-T8: Graph `subscribed_apps` on the Page toggle + the one-off backfill (Module 4 D2/D10).
 * Real Postgres + real token cipher; `MetaGraphClient` is a strict fake (only the two
 * `subscribed_apps` calls are allowed).
 */
describe('Page toggle → subscribed_apps (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  const graph = fakePageSubscriptionGraph();
  let owner: Actor;
  let other: Actor;
  let revoked: Actor;

  const http = () => request(app.getHttpServer());
  const db = (): Database => actors.db;
  const base = `7${Date.now()}`;
  let seq = 10;
  const tokens: string[] = [];

  const togglePath = (workspaceId: string, id: string) =>
    `/api/workspaces/${workspaceId}/pages/${id}/toggle`;
  const toggle = (actor: Actor, workspaceId: string, id: string, on: boolean) =>
    http()
      .patch(togglePath(workspaceId, id))
      .set('Cookie', actor.cookie)
      .send({ isActive: on });

  async function insertPage(
    workspaceId: string,
    options: { isActive?: boolean } = {},
  ) {
    seq += 1;
    const pageId = `${base}${seq}`;
    const token = `EAAsub${seq}x${base}`;
    tokens.push(token);
    const [row] = await db()
      .insert(socialPages)
      .values({
        workspaceId,
        pageId,
        pageName: `Shop ${seq}`,
        encryptedPageAccessToken: cipher.encrypt(
          token,
          tokenCipherContext('meta_page_token', workspaceId, pageId),
        ),
        isActive: options.isActive ?? false,
      })
      .returning();
    return { row: row!, token };
  }

  async function insertConnection(actor: Actor, status: MetaConnectionStatus) {
    seq += 1;
    const fbUserId = `${base}${seq}`;
    const token = `EAAuser${seq}x${base}`;
    tokens.push(token);
    await db()
      .insert(metaConnections)
      .values({
        workspaceId: actor.workspaceId,
        facebookUserId: fbUserId,
        encryptedUserAccessToken:
          status === 'REVOKED'
            ? null
            : cipher.encrypt(
                token,
                tokenCipherContext(
                  'meta_user_token',
                  actor.workspaceId,
                  fbUserId,
                ),
              ),
        grantedScopes: ['pages_show_list'],
        status,
        statusChangedAt: LONG_AGO,
      });
  }

  const pageRow = async (id: string) =>
    (await db().select().from(socialPages).where(eq(socialPages.id, id)))[0]!;
  const connectionOf = async (workspaceId: string) =>
    (
      await db()
        .select()
        .from(metaConnections)
        .where(eq(metaConnections.workspaceId, workspaceId))
    )[0]!;
  const setConnection = (workspaceId: string, status: MetaConnectionStatus) =>
    db()
      .update(metaConnections)
      .set({ status, statusChangedAt: LONG_AGO })
      .where(eq(metaConnections.workspaceId, workspaceId));
  const deletePagesOf = (workspaceId: string) =>
    db().delete(socialPages).where(eq(socialPages.workspaceId, workspaceId));

  const tokenInvalid = () =>
    new MetaGraphError('token_invalid', 'Meta Graph 400 (#190): expired', {
      status: 400,
      code: 190,
    });

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(MetaGraphClient).useValue(graph),
    );
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    owner = await actors.signUp('m4t8-owner', { trial: true });
    other = await actors.signUp('m4t8-other', { trial: true });
    revoked = await actors.signUp('m4t8-revoked', { trial: true });
    await insertConnection(owner, 'ACTIVE');
    await insertConnection(other, 'ACTIVE');
    await insertConnection(revoked, 'REVOKED');
  });

  beforeEach(async () => {
    graph.subscribePageApp.mockReset().mockResolvedValue(undefined);
    graph.unsubscribePageApp.mockReset().mockResolvedValue(undefined);
    graph.enabled = true;
    await setConnection(owner.workspaceId, 'ACTIVE');
  });

  afterEach(async () => {
    for (const actor of [owner, other, revoked]) {
      await deletePagesOf(actor.workspaceId);
    }
  });

  afterAll(async () => {
    const all = seen.join('\n');
    for (const token of tokens) expect(all).not.toContain(token);
    expect(all).not.toMatch(/"v1:e2e:/);
    await actors?.cleanup();
    await app?.close();
  });

  it('switch on → subscribe with the decrypted Page token, then 200 + row active', async () => {
    const { row, token } = await insertPage(owner.workspaceId);
    graph.subscribePageApp.mockImplementation(async () => {
      // Graph is called before the DB changes.
      expect((await pageRow(row.id)).isActive).toBe(false);
    });
    const res = record(
      await toggle(owner, owner.workspaceId, row.id, true).expect(200),
    );
    expect(res.body).toMatchObject({ changed: true, page: { isActive: true } });
    expect(graph.subscribePageApp).toHaveBeenCalledTimes(1);
    expect(graph.subscribePageApp).toHaveBeenCalledWith(row.pageId, token);
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
    expect((await pageRow(row.id)).isActive).toBe(true);
  });

  it('already on → no-op without a Graph call', async () => {
    const { row } = await insertPage(owner.workspaceId, { isActive: true });
    const res = record(
      await toggle(owner, owner.workspaceId, row.id, true).expect(200),
    );
    expect(res.body.changed).toBe(false);
    expect(graph.subscribePageApp).not.toHaveBeenCalled();
  });

  it('Graph failure → 502 META_SUBSCRIBE_FAILED, Page still off, nothing written', async () => {
    const { row } = await insertPage(owner.workspaceId);
    graph.subscribePageApp.mockRejectedValue(
      new MetaGraphError('transient', 'Meta Graph 500: try later', {
        status: 500,
      }),
    );
    const res = record(
      await toggle(owner, owner.workspaceId, row.id, true).expect(502),
    );
    expect(res.body).toMatchObject({
      statusCode: 502,
      error: 'Bad Gateway',
      code: 'META_SUBSCRIBE_FAILED',
    });
    expect(res.body).not.toHaveProperty('details');
    const after = await pageRow(row.id);
    expect(after.isActive).toBe(false);
    expect(after.updatedAt).toEqual(row.updatedAt);
    expect((await connectionOf(owner.workspaceId)).status).toBe('ACTIVE');
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
  });

  it('token_invalid → 502 + connection NEEDS_REAUTH (status_changed_at only on change)', async () => {
    const { row } = await insertPage(owner.workspaceId);
    graph.subscribePageApp.mockRejectedValue(tokenInvalid());
    const before = Date.now();
    record(await toggle(owner, owner.workspaceId, row.id, true).expect(502));
    const first = await connectionOf(owner.workspaceId);
    expect(first.status).toBe('NEEDS_REAUTH');
    expect(first.statusChangedAt.getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect((await pageRow(row.id)).isActive).toBe(false);

    // Again: now NEEDS_REAUTH → 409 before Graph (M4-T9, D9), status_changed_at kept.
    const again = record(
      await toggle(owner, owner.workspaceId, row.id, true).expect(409),
    );
    expect(again.body.code).toBe('CONNECTION_NEEDS_REAUTH');
    expect(graph.subscribePageApp).toHaveBeenCalledTimes(1);
    const second = await connectionOf(owner.workspaceId);
    expect(second.status).toBe('NEEDS_REAUTH');
    expect(second.statusChangedAt).toEqual(first.statusChangedAt);
  });

  it('token_invalid never overwrites a REVOKED connection', async () => {
    // M4-T9: switch-on under REVOKED is refused before Graph (409), so use the switch-off
    // unsubscribe path (an active Page with a token under a REVOKED connection).
    const { row } = await insertPage(revoked.workspaceId, { isActive: true });
    graph.unsubscribePageApp.mockRejectedValue(tokenInvalid());
    record(
      await toggle(revoked, revoked.workspaceId, row.id, false).expect(200),
    );
    expect(graph.unsubscribePageApp).toHaveBeenCalledTimes(1);
    const connection = await connectionOf(revoked.workspaceId);
    expect(connection.status).toBe('REVOKED');
    expect(connection.statusChangedAt).toEqual(LONG_AGO);
  });

  it('switch off → off even when unsubscribe fails; unsubscribe runs after commit', async () => {
    const { row, token } = await insertPage(owner.workspaceId, {
      isActive: true,
    });
    graph.unsubscribePageApp.mockImplementation(async () => {
      expect((await pageRow(row.id)).isActive).toBe(false);
      throw new MetaGraphError('transient', 'Meta Graph 500', { status: 500 });
    });
    const res = record(
      await toggle(owner, owner.workspaceId, row.id, false).expect(200),
    );
    expect(res.body).toMatchObject({
      changed: true,
      page: { isActive: false },
    });
    expect(graph.unsubscribePageApp).toHaveBeenCalledWith(row.pageId, token);
    expect(graph.subscribePageApp).not.toHaveBeenCalled();
    expect((await pageRow(row.id)).isActive).toBe(false);
    expect((await connectionOf(owner.workspaceId)).status).toBe('ACTIVE');
  });

  it('switch off of an already-off Page → no Graph call', async () => {
    const { row } = await insertPage(owner.workspaceId);
    record(await toggle(owner, owner.workspaceId, row.id, false).expect(200));
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
  });

  it('503 when Meta is not configured: no Graph call, Page off', async () => {
    const { row } = await insertPage(owner.workspaceId);
    graph.enabled = false;
    record(await toggle(owner, owner.workspaceId, row.id, true).expect(503));
    expect(graph.subscribePageApp).not.toHaveBeenCalled();
    expect((await pageRow(row.id)).isActive).toBe(false);
  });

  it('a token sealed for another row (undecryptable) → 409 PAGE_TOKEN_MISSING, no Graph call', async () => {
    const { row } = await insertPage(owner.workspaceId);
    await db()
      .update(socialPages)
      .set({
        encryptedPageAccessToken: cipher.encrypt(
          'EAAmovedTokenAbcdefghijklmnopqrstuvwxyz',
          tokenCipherContext('meta_page_token', other.workspaceId, row.pageId),
        ),
      })
      .where(eq(socialPages.id, row.id));
    const res = record(
      await toggle(owner, owner.workspaceId, row.id, true).expect(409),
    );
    expect(res.body.code).toBe('PAGE_TOKEN_MISSING');
    expect(graph.subscribePageApp).not.toHaveBeenCalled();
  });

  it('tenant isolation: another workspace’s Page → 404 without a Graph call, row untouched', async () => {
    const { row } = await insertPage(other.workspaceId);
    record(await toggle(owner, owner.workspaceId, row.id, true).expect(404));
    record(await toggle(owner, other.workspaceId, row.id, true).expect(404));
    expect(graph.subscribePageApp).not.toHaveBeenCalled();
    expect((await pageRow(row.id)).isActive).toBe(false);
  });

  describe('backfill (one-off script core)', () => {
    it('subscribes every active Page with a token, idempotent, token_invalid → NEEDS_REAUTH', async () => {
      const a = await insertPage(owner.workspaceId, { isActive: true });
      const b = await insertPage(other.workspaceId, { isActive: true });
      await insertPage(owner.workspaceId); // inactive: skipped
      const noToken = await insertPage(other.workspaceId, { isActive: true });
      await db()
        .update(socialPages)
        .set({ encryptedPageAccessToken: null, isActive: false })
        .where(eq(socialPages.id, noToken.row.id));
      graph.subscribePageApp.mockImplementation(async (pageId) => {
        if (pageId === b.row.pageId) throw tokenInvalid();
      });
      const subscriptions = app.get(PageSubscriptionService);

      const first = await backfillPageSubscriptions(db(), subscriptions, {
        delayMs: 0,
      });
      expect(first).toEqual({
        kind: 'done',
        counts: {
          pages: 2,
          subscribed: 1,
          failed: 1,
          undecryptable: 0,
          connectionsMarkedNeedsReauth: 1,
          notAttempted: 0,
        },
      });
      expect(graph.subscribePageApp).toHaveBeenCalledTimes(2);
      expect(graph.subscribePageApp).toHaveBeenCalledWith(
        a.row.pageId,
        a.token,
      );
      expect(graph.subscribePageApp).toHaveBeenCalledWith(
        b.row.pageId,
        b.token,
      );
      expect((await connectionOf(other.workspaceId)).status).toBe(
        'NEEDS_REAUTH',
      );
      expect((await connectionOf(owner.workspaceId)).status).toBe('ACTIVE');

      // Re-run: same calls again (Meta treats them as no-ops), the connection is not re-marked.
      graph.subscribePageApp.mockClear();
      const second = await backfillPageSubscriptions(db(), subscriptions, {
        delayMs: 0,
      });
      expect(second).toMatchObject({
        counts: { pages: 2, subscribed: 1, connectionsMarkedNeedsReauth: 0 },
      });
      expect(graph.subscribePageApp).toHaveBeenCalledTimes(2);
      await setConnection(other.workspaceId, 'ACTIVE');
    });

    it('skips cleanly when Meta is not configured', async () => {
      await insertPage(owner.workspaceId, { isActive: true });
      graph.enabled = false;
      await expect(
        backfillPageSubscriptions(db(), app.get(PageSubscriptionService)),
      ).resolves.toEqual({ kind: 'skipped', reason: 'not_configured' });
      expect(graph.subscribePageApp).not.toHaveBeenCalled();
    });
  });
});
