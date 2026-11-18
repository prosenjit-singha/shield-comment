import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { normalizeFeatureConfig } from '../src/admin/plan-rules.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import { plans, socialPages, workspaces } from '../src/db/schema/index.js';
import { MetaGraphClient } from '../src/meta/meta-graph.client.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { fakePageSubscriptionGraph } from './utils/fake-meta-graph.js';

/** Every response's headers and body, to prove no token or ciphertext ever leaks. */
const seen: string[] = [];
const record = (res: request.Response) => {
  seen.push(JSON.stringify({ h: res.headers, b: res.body, t: res.text }));
  return res;
};

/**
 * M3-T6: workspace pages API (user decisions D3/D5/D7/D10 2026-11-18). Real Postgres + real
 * token cipher; `social_pages` rows are inserted directly with real ciphertexts. Switch-on calls
 * Graph `subscribed_apps` since M4-T8: a fake answers it (Graph failure cases are in
 * `meta-page-subscribe.e2e-spec.ts`); any other Graph call fails the spec.
 */
describe('Workspace pages API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  const graph = fakePageSubscriptionGraph();
  let owner: Actor;
  let other: Actor;
  let growth: Actor;
  let moderator: Actor;
  let wsAdmin: Actor;
  let outsider: Actor;
  let superAdmin: Actor;
  let freeLimit: number;
  let growthLimit: number;

  const http = () => request(app.getHttpServer());
  const db = () => actors.db;
  // Meta ids are numeric strings, unique per run.
  const base = `8${Date.now()}`;
  let seq = 10;
  const tokens: string[] = [];

  const listPath = (workspaceId: string) =>
    `/api/workspaces/${workspaceId}/pages`;
  const togglePath = (workspaceId: string, id: string) =>
    `/api/workspaces/${workspaceId}/pages/${id}/toggle`;

  async function insertPage(
    workspaceId: string,
    name: string,
    options: { token?: boolean; isActive?: boolean; ig?: boolean } = {},
  ) {
    seq += 1;
    const pageId = `${base}${seq}`;
    const token = `EAApage${seq}x${base}`;
    tokens.push(token);
    const withToken = options.token ?? true;
    const [row] = await db()
      .insert(socialPages)
      .values({
        workspaceId,
        pageId,
        pageName: name,
        igBusinessId: options.ig ? `${base}9${seq}` : null,
        igUsername: options.ig ? `shop.${seq}` : null,
        encryptedPageAccessToken: withToken
          ? cipher.encrypt(
              token,
              tokenCipherContext('meta_page_token', workspaceId, pageId),
            )
          : null,
        isActive: options.isActive ?? false,
      })
      .returning();
    return row!;
  }

  const rowOf = async (id: string) => {
    const [row] = await db()
      .select()
      .from(socialPages)
      .where(eq(socialPages.id, id));
    return row!;
  };

  const limitOf = async (slug: string) => {
    const [plan] = await db()
      .select({ featureConfig: plans.featureConfig })
      .from(plans)
      .where(eq(plans.slug, slug));
    return normalizeFeatureConfig(plan!.featureConfig).limits.connectedPages;
  };

  const toggle = (
    actor: Actor | string,
    workspaceId: string,
    id: string,
    isActive: unknown,
  ) =>
    http()
      .patch(togglePath(workspaceId, id))
      .set('Cookie', typeof actor === 'string' ? actor : actor.cookie)
      .send({ isActive });

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(MetaGraphClient).useValue(graph),
    );
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    owner = await actors.signUp('m3t6-owner');
    other = await actors.signUp('m3t6-other');
    growth = await actors.signUp('m3t6-growth');
    moderator = await actors.signUp('m3t6-mod');
    wsAdmin = await actors.signUp('m3t6-admin');
    outsider = await actors.signUp('m3t6-outsider');
    superAdmin = await actors.signUpSuperAdmin('m3t6-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
    freeLimit = await limitOf('free');
    growthLimit = await limitOf('growth');
    // The limit tests need room for at least one active Page on Free and more on Growth.
    expect(freeLimit).toBeGreaterThanOrEqual(1);
    expect(growthLimit).toBeGreaterThan(freeLimit);
    const [growthPlan] = await db()
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.slug, 'growth'));
    await db()
      .update(workspaces)
      .set({ planId: growthPlan!.id })
      .where(eq(workspaces.id, growth.workspaceId));
  });

  afterAll(async () => {
    // No response ever carried a Page token or a ciphertext.
    const all = seen.join('\n');
    for (const token of tokens) expect(all).not.toContain(token);
    expect(all).not.toMatch(/"v1:e2e:/);
    expect(all).not.toMatch(/encrypted/i);
    await actors?.cleanup();
    await app?.close();
  });

  describe('auth + roles (D5)', () => {
    let pageId: string;
    beforeAll(async () => {
      pageId = (await insertPage(owner.workspaceId, 'Roles Page')).id;
    });

    it('401 without a session', async () => {
      record(await http().get(listPath(owner.workspaceId)).expect(401));
      record(
        await http()
          .patch(togglePath(owner.workspaceId, pageId))
          .send({ isActive: true })
          .expect(401),
      );
    });

    it('403 for a moderator (list + toggle)', async () => {
      const cookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      record(
        await http()
          .get(listPath(owner.workspaceId))
          .set('Cookie', cookie)
          .expect(403),
      );
      record(await toggle(cookie, owner.workspaceId, pageId, true).expect(403));
      expect((await rowOf(pageId)).isActive).toBe(false);
    });

    it('404 for a non-member (list + toggle)', async () => {
      record(
        await http()
          .get(listPath(owner.workspaceId))
          .set('Cookie', outsider.cookie)
          .expect(404),
      );
      record(
        await toggle(outsider, owner.workspaceId, pageId, true).expect(404),
      );
      expect((await rowOf(pageId)).isActive).toBe(false);
    });

    it('a workspace admin may list and toggle', async () => {
      const list = record(
        await http()
          .get(listPath(owner.workspaceId))
          .set('Cookie', wsAdmin.cookie)
          .expect(200),
      );
      expect(list.body.items.map((p: { id: string }) => p.id)).toContain(
        pageId,
      );
      record(
        await toggle(wsAdmin, owner.workspaceId, pageId, true).expect(200),
      );
      record(
        await toggle(wsAdmin, owner.workspaceId, pageId, false).expect(200),
      );
    });

    it('an impersonated session may toggle (connect is blocked, toggle is not)', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      record(
        await http()
          .get(listPath(owner.workspaceId))
          .set('Cookie', cookie)
          .expect(200),
      );
      const on = record(
        await toggle(cookie, owner.workspaceId, pageId, true).expect(200),
      );
      expect(on.body).toMatchObject({
        changed: true,
        page: { isActive: true },
      });
      const off = record(
        await toggle(cookie, owner.workspaceId, pageId, false).expect(200),
      );
      expect(off.body.changed).toBe(true);
      expect((await rowOf(pageId)).isActive).toBe(false);
    });

    afterAll(async () => {
      await db().delete(socialPages).where(eq(socialPages.id, pageId));
    });
  });

  describe('list + toggle (D10)', () => {
    const ownerPages: string[] = [];
    let noToken: string;
    let foreign: string;

    beforeAll(async () => {
      // Inserted out of name order; one with IG, one without a token (missing on re-connect).
      for (let i = freeLimit; i >= 0; i--) {
        const row = await insertPage(owner.workspaceId, `Shop ${i}`, {
          ig: i === 0,
        });
        ownerPages.unshift(row.id);
      }
      noToken = (
        await insertPage(owner.workspaceId, 'Archived Shop', { token: false })
      ).id;
      foreign = (
        await insertPage(other.workspaceId, 'Other Shop', { isActive: true })
      ).id;
    });

    it('GET lists the workspace’s Pages sorted by name, without tokens, with the Free limit', async () => {
      const res = record(
        await http()
          .get(listPath(owner.workspaceId))
          .set('Cookie', owner.cookie)
          .expect(200),
      );
      expect(Object.keys(res.body).sort()).toEqual(['items', 'pageLimit']);
      expect(res.body.pageLimit).toEqual({ limit: freeLimit, activeCount: 0 });
      const items = res.body.items as Record<string, unknown>[];
      expect(items.map((p) => p.id)).toEqual([noToken, ...ownerPages]);
      expect(items.map((p) => p.pageName)).toEqual([
        'Archived Shop',
        ...ownerPages.map((_, i) => `Shop ${i}`),
      ]);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(
          [
            'createdAt',
            'hasToken',
            'id',
            'igBusinessId',
            'igUsername',
            'isActive',
            'pageId',
            'pageName',
            'updatedAt',
          ].sort(),
        );
      }
      expect(items[0]).toMatchObject({ hasToken: false, isActive: false });
      expect(items[1]).toMatchObject({
        hasToken: true,
        igBusinessId: expect.stringMatching(/^\d+$/),
        igUsername: expect.stringMatching(/^shop\./),
      });
      expect(items[2]).toMatchObject({ igBusinessId: null, igUsername: null });
      expect(items.map((p) => p.id)).not.toContain(foreign);
    });

    it('other workspace’s list never shows the owner’s Pages', async () => {
      const res = record(
        await http()
          .get(listPath(other.workspaceId))
          .set('Cookie', other.cookie)
          .expect(200),
      );
      expect(res.body.items.map((p: { id: string }) => p.id)).toEqual([
        foreign,
      ]);
      expect(res.body.pageLimit).toEqual({ limit: freeLimit, activeCount: 1 });
    });

    it('toggle on → { page, changed: true }, row active, updated_at moves', async () => {
      const before = await rowOf(ownerPages[0]!);
      const res = record(
        await toggle(owner, owner.workspaceId, ownerPages[0]!, true).expect(
          200,
        ),
      );
      expect(Object.keys(res.body).sort()).toEqual(['changed', 'page']);
      expect(res.body.changed).toBe(true);
      expect(res.body.page).toMatchObject({
        id: ownerPages[0],
        isActive: true,
        hasToken: true,
      });
      const after = await rowOf(ownerPages[0]!);
      expect(after.isActive).toBe(true);
      expect(after.updatedAt.getTime()).toBeGreaterThan(
        before.updatedAt.getTime(),
      );
      expect(after.encryptedPageAccessToken).toBe(
        before.encryptedPageAccessToken,
      );
    });

    it('same value again = no-op: changed false, updated_at kept', async () => {
      const before = await rowOf(ownerPages[0]!);
      const res = record(
        await toggle(owner, owner.workspaceId, ownerPages[0]!, true).expect(
          200,
        ),
      );
      expect(res.body.changed).toBe(false);
      expect(res.body.page.isActive).toBe(true);
      expect(new Date(res.body.page.updatedAt as string).getTime()).toBe(
        before.updatedAt.getTime(),
      );
      expect((await rowOf(ownerPages[0]!)).updatedAt).toEqual(before.updatedAt);
      // An inactive Page switched off is a no-op too.
      const off = record(
        await toggle(owner, owner.workspaceId, noToken, false).expect(200),
      );
      expect(off.body.changed).toBe(false);
    });

    it('409 PAGE_LIMIT_REACHED with limit + active count once the Free limit is used', async () => {
      // Fill the rest of the Free limit.
      for (const id of ownerPages.slice(1, freeLimit)) {
        record(await toggle(owner, owner.workspaceId, id, true).expect(200));
      }
      const last = ownerPages[freeLimit]!;
      const before = await rowOf(last);
      const res = record(
        await toggle(owner, owner.workspaceId, last, true).expect(409),
      );
      expect(res.body).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: 'PAGE_LIMIT_REACHED',
        details: { limit: freeLimit, activeCount: freeLimit },
      });
      expect(res.body.message).toMatch(/plan/i);
      expect(await rowOf(last)).toEqual(before);
      const list = record(
        await http()
          .get(listPath(owner.workspaceId))
          .set('Cookie', owner.cookie)
          .expect(200),
      );
      expect(list.body.pageLimit).toEqual({
        limit: freeLimit,
        activeCount: freeLimit,
      });
    });

    it('deactivating frees a slot; another Page can then be switched on', async () => {
      const off = record(
        await toggle(owner, owner.workspaceId, ownerPages[0]!, false).expect(
          200,
        ),
      );
      expect(off.body).toMatchObject({
        changed: true,
        page: { isActive: false },
      });
      record(
        await toggle(
          owner,
          owner.workspaceId,
          ownerPages[freeLimit]!,
          true,
        ).expect(200),
      );
      expect((await rowOf(ownerPages[freeLimit]!)).isActive).toBe(true);
    });

    it('409 PAGE_TOKEN_MISSING for a Page without a token', async () => {
      // Make room first so the refusal is about the token, not the limit.
      record(
        await toggle(
          owner,
          owner.workspaceId,
          ownerPages[freeLimit]!,
          false,
        ).expect(200),
      );
      const before = await rowOf(noToken);
      const res = record(
        await toggle(owner, owner.workspaceId, noToken, true).expect(409),
      );
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'PAGE_TOKEN_MISSING',
      });
      expect(res.body.message).toMatch(/reconnect/i);
      expect(res.body).not.toHaveProperty('details');
      expect(await rowOf(noToken)).toEqual(before);
    });

    it('another workspace’s Page id → 404, row untouched', async () => {
      const before = await rowOf(foreign);
      const res = record(
        await toggle(owner, owner.workspaceId, foreign, false).expect(404),
      );
      expect(res.body.message).toBe('Page not found');
      // Not through the other workspace's path either.
      record(
        await toggle(owner, other.workspaceId, foreign, false).expect(404),
      );
      expect(await rowOf(foreign)).toEqual(before);
    });

    it('unknown uuid → 404, non-uuid id → 400', async () => {
      record(
        await toggle(
          owner,
          owner.workspaceId,
          '019a0000-0000-7000-8000-000000000000',
          true,
        ).expect(404),
      );
      record(
        await toggle(owner, owner.workspaceId, 'not-a-uuid', true).expect(400),
      );
      record(await toggle(owner, owner.workspaceId, '123', true).expect(400));
    });

    it('strict body: missing, non-boolean or extra fields → 400', async () => {
      const id = ownerPages[0]!;
      const before = await rowOf(id);
      for (const body of [
        {},
        { isActive: 'true' },
        { isActive: 1 },
        { isActive: null },
        { isActive: true, workspaceId: other.workspaceId },
        { isActive: true, pageId: '1' },
      ]) {
        record(
          await http()
            .patch(togglePath(owner.workspaceId, id))
            .set('Cookie', owner.cookie)
            .send(body)
            .expect(400),
        );
      }
      expect(await rowOf(id)).toEqual(before);
    });

    it('concurrent activations can’t both pass the limit (workspace row lock)', async () => {
      // freeLimit - 1 Pages are on now (ownerPages[1..freeLimit-1]); one slot is left.
      const extra = await insertPage(owner.workspaceId, 'Shop race');
      const [a, b] = [ownerPages[0]!, extra.id];
      // A concurrent toggle of `a` holds the workspace lock and has switched `a` on, uncommitted.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = db().transaction(async (tx) => {
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, owner.workspaceId))
          .for('no key update');
        await tx
          .update(socialPages)
          .set({ isActive: true })
          .where(eq(socialPages.id, a));
        locked();
        await gate;
      });
      await lockTaken;
      let settled = false;
      let pending: Promise<request.Response>;
      try {
        pending = toggle(owner, owner.workspaceId, b, true).then((res) => {
          settled = true;
          return res;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Without the lock it would have counted the committed (freeLimit - 1) and answered 200.
        expect(settled).toBe(false);
      } finally {
        release();
        await holder;
      }
      const res = record(await pending);
      expect(res.status).toBe(409);
      expect(res.body.details).toEqual({
        limit: freeLimit,
        activeCount: freeLimit,
      });
      expect((await rowOf(b)).isActive).toBe(false);
      const list = record(
        await http()
          .get(listPath(owner.workspaceId))
          .set('Cookie', owner.cookie)
          .expect(200),
      );
      expect(list.body.pageLimit).toEqual({
        limit: freeLimit,
        activeCount: freeLimit,
      });
    });
  });

  describe('workspace with a plan', () => {
    it('uses its plan’s connectedPages instead of Free', async () => {
      const ids: string[] = [];
      for (let i = 0; i <= growthLimit; i++) {
        ids.push((await insertPage(growth.workspaceId, `G ${i}`)).id);
      }
      for (const id of ids.slice(0, growthLimit)) {
        record(await toggle(growth, growth.workspaceId, id, true).expect(200));
      }
      const res = record(
        await toggle(
          growth,
          growth.workspaceId,
          ids[growthLimit]!,
          true,
        ).expect(409),
      );
      expect(res.body.details).toEqual({
        limit: growthLimit,
        activeCount: growthLimit,
      });
      const list = record(
        await http()
          .get(listPath(growth.workspaceId))
          .set('Cookie', growth.cookie)
          .expect(200),
      );
      expect(list.body.pageLimit).toEqual({
        limit: growthLimit,
        activeCount: growthLimit,
      });
    });
  });
});
