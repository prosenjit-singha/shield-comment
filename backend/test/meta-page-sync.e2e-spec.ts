import type { INestApplication } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import { metaConnections, socialPages } from '../src/db/schema/index.js';
import {
  MetaGraphClient,
  type MetaPageAccount,
} from '../src/meta/meta-graph.client.js';
import { MetaGraphError } from '../src/meta/meta-graph.errors.js';
import { MetaOAuthStateStore } from '../src/meta/meta-oauth-state.store.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { MemoryMetaOAuthStateStore } from './utils/memory-oauth-state-store.js';

const CLIENT = 'http://app.localhost:5174';
const CALLBACK = '/api/meta/oauth/callback';

/** Every response's headers and body, to prove no token ever leaks. */
const seen: string[] = [];
const record = (res: request.Response) => {
  seen.push(JSON.stringify({ h: res.headers, b: res.body, t: res.text }));
  return res;
};

/**
 * M3-T5 (+ Module 3 gate item 2): the OAuth callback syncs `/me/accounts` Pages into
 * `social_pages` in one transaction with the connection (user decisions D7/D10 2026-11-18).
 * Real Postgres + real token cipher; `MetaGraphClient` and the Redis state store are replaced.
 */
describe('Meta Page sync on connect (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  const states = new MemoryMetaOAuthStateStore();
  const graph = {
    enabled: true,
    graphApiVersion: 'v26.0',
    buildLoginUrl: vi.fn(
      (state: string) =>
        `https://www.facebook.com/v26.0/dialog/oauth?client_id=1&state=${state}`,
    ),
    exchangeCode: vi.fn(),
    exchangeForLongLivedToken: vi.fn(),
    getMe: vi.fn(),
    getPermissions: vi.fn(),
    getPages: vi.fn(),
  };
  let owner: Actor;
  let other: Actor;
  let third: Actor;

  const http = () => request(app.getHttpServer());
  const db = () => actors.db;
  // Unique per run: Meta ids are numeric strings.
  const base = `7${Date.now()}`;
  const PAGE_A = `${base}01`;
  const PAGE_B = `${base}02`;
  const PAGE_C = `${base}03`;
  const PAGE_D = `${base}04`;
  const IG_A = `${base}91`;
  let seq = 0;

  const fbPage = (
    id: string,
    name: string,
    instagram: MetaPageAccount['instagram'] = null,
  ): MetaPageAccount => {
    seq += 1;
    return { id, name, accessToken: `EAApage${seq}x${id}`, instagram };
  };

  /** Arms the fake Graph for one exchange that lists `pages` (or fails on getPages). */
  function armGraph(fbUserId: string, pages: MetaPageAccount[] | Error) {
    seq += 1;
    graph.exchangeCode.mockResolvedValueOnce({
      accessToken: `EAAshort${seq}x${base}`,
      expiresAt: null,
    });
    graph.exchangeForLongLivedToken.mockResolvedValueOnce({
      accessToken: `EAAlong${seq}x${base}`,
      expiresAt: new Date('2027-01-17T00:00:00.000Z'),
    });
    graph.getMe.mockResolvedValueOnce({ id: fbUserId, name: 'Owner' });
    graph.getPermissions.mockResolvedValueOnce({
      granted: ['pages_show_list'],
      declined: [],
    });
    if (pages instanceof Error) graph.getPages.mockRejectedValueOnce(pages);
    else graph.getPages.mockResolvedValueOnce(pages);
  }

  /** Full connect round trip for `actor`; returns the callback's redirect. */
  async function connect(
    actor: Actor,
    pages: MetaPageAccount[] | Error,
    fbUserId = `${base}5`,
  ): Promise<string> {
    const start = record(
      await http()
        .get(`/api/workspaces/${actor.workspaceId}/meta/oauth/url`)
        .set('Cookie', actor.cookie)
        .expect(200),
    );
    const state = new URL(start.body.url as string).searchParams.get('state')!;
    armGraph(fbUserId, pages);
    const res = record(
      await http()
        .get(CALLBACK)
        .query({ code: `AQD-code-${seq}`, state })
        .set('Cookie', actor.cookie),
    );
    expect(res.status).toBe(302);
    return res.headers['location'] as string;
  }

  const pagesOf = (workspaceId: string) =>
    db()
      .select()
      .from(socialPages)
      .where(eq(socialPages.workspaceId, workspaceId))
      .orderBy(asc(socialPages.pageId));

  const connectionsOf = (workspaceId: string) =>
    db()
      .select()
      .from(metaConnections)
      .where(eq(metaConnections.workspaceId, workspaceId));

  const decryptPage = (stored: string, workspaceId: string, pageId: string) =>
    cipher.decrypt(
      stored,
      tokenCipherContext('meta_page_token', workspaceId, pageId),
    );

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(MetaGraphClient)
        .useValue(graph)
        .overrideProvider(MetaOAuthStateStore)
        .useValue(states),
    );
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    owner = await actors.signUp('m3t5-owner');
    other = await actors.signUp('m3t5-other');
    third = await actors.signUp('m3t5-third');
  });

  beforeEach(() => {
    for (const fn of [
      graph.exchangeCode,
      graph.exchangeForLongLivedToken,
      graph.getMe,
      graph.getPermissions,
      graph.getPages,
    ]) {
      fn.mockReset();
    }
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('gate: 2 Pages (one with IG) → 2 inactive rows, IG on the right one, tokens decrypt per Page', async () => {
    const a = fbPage(PAGE_A, 'Shop A', { id: IG_A, username: 'shop.a' });
    const b = fbPage(PAGE_B, 'Shop B');
    expect(await connect(owner, [a, b])).toBe(
      `${CLIENT}/onboarding?meta=connected`,
    );
    const longLived = (await graph.exchangeForLongLivedToken.mock.results[0]!
      .value) as { accessToken: string };
    expect(graph.getPages).toHaveBeenCalledWith(longLived.accessToken);

    const rows = await pagesOf(owner.workspaceId);
    expect(rows).toHaveLength(2);
    const [rowA, rowB] = rows;
    expect(rowA).toMatchObject({
      workspaceId: owner.workspaceId,
      pageId: PAGE_A,
      pageName: 'Shop A',
      igBusinessId: IG_A,
      igUsername: 'shop.a',
      isActive: false,
    });
    expect(rowB).toMatchObject({
      workspaceId: owner.workspaceId,
      pageId: PAGE_B,
      pageName: 'Shop B',
      igBusinessId: null,
      igUsername: null,
      isActive: false,
    });
    for (const [row, fb] of [
      [rowA!, a],
      [rowB!, b],
    ] as const) {
      expect(row.encryptedPageAccessToken).toMatch(/^v1:e2e:/);
      expect(row.encryptedPageAccessToken).not.toContain(fb.accessToken);
      expect(
        decryptPage(row.encryptedPageAccessToken!, owner.workspaceId, fb.id),
      ).toBe(fb.accessToken);
    }
    // Bound to its Page: B's context can't open A's token.
    expect(() =>
      decryptPage(rowA!.encryptedPageAccessToken!, owner.workspaceId, PAGE_B),
    ).toThrow();
    expect(await connectionsOf(owner.workspaceId)).toHaveLength(1);
  });

  it('re-connect updates in place (no duplicates) and keeps an active Page active', async () => {
    const before = await pagesOf(owner.workspaceId);
    await db()
      .update(socialPages)
      .set({ isActive: true })
      .where(eq(socialPages.pageId, PAGE_A));

    const a = fbPage(PAGE_A, 'Shop A (new name)', {
      id: IG_A,
      username: 'shop.a.bd',
    });
    const b = fbPage(PAGE_B, 'Shop B');
    expect(await connect(owner, [a, b])).toBe(
      `${CLIENT}/onboarding?meta=connected`,
    );

    const rows = await pagesOf(owner.workspaceId);
    expect(rows).toHaveLength(2);
    const [rowA, rowB] = rows;
    expect(rowA!.id).toBe(before[0]!.id);
    expect(rowA!.createdAt).toEqual(before[0]!.createdAt);
    expect(rowA).toMatchObject({
      pageName: 'Shop A (new name)',
      igUsername: 'shop.a.bd',
      isActive: true,
    });
    expect(
      decryptPage(rowA!.encryptedPageAccessToken!, owner.workspaceId, PAGE_A),
    ).toBe(a.accessToken);
    expect(rowB!.id).toBe(before[1]!.id);
    expect(rowB!.isActive).toBe(false);
    expect(
      decryptPage(rowB!.encryptedPageAccessToken!, owner.workspaceId, PAGE_B),
    ).toBe(b.accessToken);
    expect(await connectionsOf(owner.workspaceId)).toHaveLength(1);
  });

  it('a Page missing on re-connect keeps its row, becomes inactive, token cleared; it comes back inactive', async () => {
    await db()
      .update(socialPages)
      .set({ isActive: true })
      .where(eq(socialPages.pageId, PAGE_B));
    const [, beforeB] = await pagesOf(owner.workspaceId);

    expect(
      await connect(owner, [
        fbPage(PAGE_A, 'Shop A (new name)', {
          id: IG_A,
          username: 'shop.a.bd',
        }),
      ]),
    ).toBe(`${CLIENT}/onboarding?meta=connected`);
    let [rowA, rowB] = await pagesOf(owner.workspaceId);
    expect(rowA!.isActive).toBe(true);
    expect(rowB).toMatchObject({
      id: beforeB!.id,
      pageId: PAGE_B,
      pageName: 'Shop B',
      isActive: false,
      encryptedPageAccessToken: null,
    });

    const b = fbPage(PAGE_B, 'Shop B');
    await connect(owner, [
      fbPage(PAGE_A, 'Shop A (new name)', { id: IG_A, username: 'shop.a.bd' }),
      b,
    ]);
    [rowA, rowB] = await pagesOf(owner.workspaceId);
    expect(rowA!.isActive).toBe(true);
    expect(rowB!.id).toBe(beforeB!.id);
    expect(rowB!.isActive).toBe(false);
    expect(
      decryptPage(rowB!.encryptedPageAccessToken!, owner.workspaceId, PAGE_B),
    ).toBe(b.accessToken);
  });

  it('Pages (or IG accounts) of another workspace are skipped, never moved or overwritten', async () => {
    const ownerBefore = await pagesOf(owner.workspaceId);
    const location = await connect(
      other,
      [
        fbPage(PAGE_A, 'Hijacked A'),
        fbPage(PAGE_C, 'Shop C with A’s IG', { id: IG_A, username: 'x' }),
        fbPage(PAGE_D, 'Shop D'),
      ],
      `${base}6`,
    );
    expect(location).toBe(`${CLIENT}/onboarding?meta=connected&skipped=2`);

    expect(await pagesOf(owner.workspaceId)).toEqual(ownerBefore);
    const otherRows = await pagesOf(other.workspaceId);
    expect(otherRows.map((r) => [r.pageId, r.isActive])).toEqual([
      [PAGE_D, false],
    ]);
    expect(await connectionsOf(other.workspaceId)).toHaveLength(1);
  });

  it('other workspaces can’t see or open the rows', async () => {
    const ownerRows = await pagesOf(owner.workspaceId);
    const otherRows = await pagesOf(other.workspaceId);
    const ownerIds = new Set(ownerRows.map((r) => r.id));
    expect(otherRows.some((r) => ownerIds.has(r.id))).toBe(false);
    // Ciphertexts are bound to their workspace.
    const [rowA] = ownerRows;
    expect(() =>
      decryptPage(rowA!.encryptedPageAccessToken!, other.workspaceId, PAGE_A),
    ).toThrow();
  });

  it.each([
    [
      'rate limit',
      new MetaGraphError('rate_limited', 'Meta Graph 400 (#4): limit', {
        status: 400,
        code: 4,
      }),
      'meta_unavailable',
    ],
    [
      'bad body',
      new MetaGraphError('unexpected_response', 'bad Page in /me/accounts'),
      'meta_error',
    ],
  ])(
    'getPages error (%s) → no connection, no Pages written',
    async (_k, err, reason) => {
      expect(await connect(third, err)).toBe(
        `${CLIENT}/onboarding?meta=error&reason=${reason}`,
      );
      expect(await connectionsOf(third.workspaceId)).toHaveLength(0);
      expect(await pagesOf(third.workspaceId)).toHaveLength(0);
    },
  );

  it('getPages error on re-connect leaves the connection and Pages as they were', async () => {
    const [connBefore] = await connectionsOf(owner.workspaceId);
    const pagesBefore = await pagesOf(owner.workspaceId);
    expect(
      await connect(
        owner,
        new MetaGraphError('token_invalid', 'Meta Graph 401 (#190)', {
          status: 401,
          code: 190,
        }),
      ),
    ).toBe(`${CLIENT}/onboarding?meta=error&reason=meta_error`);
    expect(await connectionsOf(owner.workspaceId)).toEqual([connBefore]);
    expect(await pagesOf(owner.workspaceId)).toEqual(pagesBefore);
  });

  it('a DB failure in the Page sync rolls back the connection too (one transaction)', async () => {
    // Bypasses the client's id check: the DB format check (23514) fails mid-sync.
    const bad: MetaPageAccount = {
      id: 'not-numeric',
      name: 'Broken',
      accessToken: 'EAAbroken',
      instagram: null,
    };
    expect(await connect(third, [fbPage(`${base}08`, 'Fine'), bad])).toBe(
      `${CLIENT}/onboarding?meta=error&reason=server_error`,
    );
    expect(await connectionsOf(third.workspaceId)).toHaveLength(0);
    expect(await pagesOf(third.workspaceId)).toHaveLength(0);
  });

  it('only this run’s rows exist for the Page ids used', async () => {
    const rows = await db()
      .select({ pageId: socialPages.pageId })
      .from(socialPages)
      .where(
        inArray(socialPages.pageId, [
          PAGE_A,
          PAGE_B,
          PAGE_C,
          PAGE_D,
          `${base}08`,
        ]),
      );
    expect(rows.map((r) => r.pageId).sort()).toEqual(
      [PAGE_A, PAGE_B, PAGE_D].sort(),
    );
  });

  it('tokens and ciphertexts never appear in any response', () => {
    const all = seen.join('\n');
    expect(seen.length).toBeGreaterThan(10);
    expect(all).not.toMatch(/EAA(short|long|page|broken)/);
    expect(all).not.toContain('v1:e2e:');
  });
});
