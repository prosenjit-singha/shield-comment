import type { INestApplication } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import { metaConnections } from '../src/db/schema/index.js';
import { MetaGraphClient } from '../src/meta/meta-graph.client.js';
import { MetaGraphError } from '../src/meta/meta-graph.errors.js';
import { MetaOAuthStateStore } from '../src/meta/meta-oauth-state.store.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { MemoryMetaOAuthStateStore } from './utils/memory-oauth-state-store.js';

const CLIENT = 'http://app.localhost:5174';
const CALLBACK = '/api/meta/oauth/callback';
const urlPath = (workspaceId: string) =>
  `/api/workspaces/${workspaceId}/meta/oauth/url`;
const errorRedirect = (reason: string, path = '/onboarding') =>
  `${CLIENT}${path}?meta=error&reason=${reason}`;

/** Every response's status line, headers and body, to prove no token ever leaks. */
const seen: string[] = [];
const record = (res: request.Response) => {
  seen.push(JSON.stringify({ h: res.headers, b: res.body, t: res.text }));
  return res;
};

/** Stand-in for the only code that talks to Meta (no live calls). */
function fakeGraph() {
  return {
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
}

/**
 * M3-T4: Meta OAuth connect flow (user decisions D5/D6 2026-11-18). Real Postgres + real token
 * cipher (e2e env key); `MetaGraphClient` and the Redis state store are replaced.
 */
describe('Meta OAuth connect (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const graph = fakeGraph();
  const states = new MemoryMetaOAuthStateStore();
  let owner: Actor;
  let other: Actor;
  let moderator: Actor;
  let admin: Actor;
  let superAdmin: Actor;

  const http = () => request(app.getHttpServer());
  const db = () => actors.db;
  // Unique per run: FB ids are numeric strings.
  const base = `8${Date.now()}`;
  let tokenSeq = 0;

  /** Arms the fake Graph for one successful exchange; returns the tokens it will hand out. */
  function armGraph(fbUserId = `${base}1`) {
    tokenSeq += 1;
    const tokens = {
      code: `AQD-code-${tokenSeq}-${base}`,
      short: `EAAshort${tokenSeq}x${base}`,
      long: `EAAlong${tokenSeq}x${base}`,
    };
    graph.exchangeCode.mockResolvedValueOnce({
      accessToken: tokens.short,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    graph.exchangeForLongLivedToken.mockResolvedValueOnce({
      accessToken: tokens.long,
      expiresAt: new Date('2027-01-17T00:00:00.000Z'),
    });
    graph.getMe.mockResolvedValueOnce({ id: fbUserId, name: 'Owner' });
    graph.getPermissions.mockResolvedValueOnce({
      granted: ['pages_show_list', 'pages_manage_engagement'],
      declined: ['instagram_basic'],
    });
    return tokens;
  }

  async function startFlow(actor: Actor, query = '') {
    const res = record(
      await http()
        .get(`${urlPath(actor.workspaceId)}${query}`)
        .set('Cookie', actor.cookie),
    );
    expect(res.status).toBe(200);
    const state = new URL(res.body.url as string).searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return state!;
  }

  async function callback(query: Record<string, string>, cookie?: string) {
    const req = http().get(CALLBACK).query(query);
    if (cookie) req.set('Cookie', cookie);
    const res = record(await req);
    expect(res.status).toBe(302);
    return res.headers['location'] as string;
  }

  const connectionsOf = (workspaceId: string) =>
    db()
      .select()
      .from(metaConnections)
      .where(eq(metaConnections.workspaceId, workspaceId));

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(MetaGraphClient)
        .useValue(graph)
        .overrideProvider(MetaOAuthStateStore)
        .useValue(states),
    );
    actors = createAuthActors(app);
    owner = await actors.signUp('m3t4-owner');
    other = await actors.signUp('m3t4-other');
    moderator = await actors.signUp('m3t4-mod');
    admin = await actors.signUp('m3t4-admin');
    superAdmin = await actors.signUpSuperAdmin('m3t4-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    await actors.addMember(owner.workspaceId, admin.id, 'admin');
  });

  beforeEach(() => {
    graph.enabled = true;
    graph.exchangeCode.mockReset();
    graph.exchangeForLongLivedToken.mockReset();
    graph.getMe.mockReset();
    graph.getPermissions.mockReset();
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('GET /api/workspaces/:workspaceId/meta/oauth/url', () => {
    it('owner: 200 { url } only, state stored for 10 minutes', async () => {
      const before = states.size;
      const res = record(
        await http()
          .get(urlPath(owner.workspaceId))
          .set('Cookie', owner.cookie)
          .expect(200),
      );
      expect(Object.keys(res.body)).toEqual(['url']);
      expect(res.body.url).toMatch(
        /^https:\/\/www\.facebook\.com\/v26\.0\/dialog\/oauth\?/,
      );
      expect(states.size).toBe(before + 1);
      expect(states.ttls.at(-1)).toBe(600);
    });

    it('400 for a returnTo outside the allowlist or an unknown param', async () => {
      for (const query of [
        '?returnTo=/dashboard',
        '?returnTo=https://evil.example/pages',
        '?returnTo=//evil.example',
        '?foo=1',
      ]) {
        record(
          await http()
            .get(`${urlPath(owner.workspaceId)}${query}`)
            .set('Cookie', owner.cookie)
            .expect(400),
        );
      }
    });

    it('401 without a session', async () => {
      record(await http().get(urlPath(owner.workspaceId)).expect(401));
    });

    it('404 for a non-member (other workspace’s id)', async () => {
      record(
        await http()
          .get(urlPath(owner.workspaceId))
          .set('Cookie', other.cookie)
          .expect(404),
      );
    });

    it('403 for a moderator', async () => {
      const cookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      record(
        await http()
          .get(urlPath(owner.workspaceId))
          .set('Cookie', cookie)
          .expect(403),
      );
    });

    it('200 for a workspace admin whose active workspace it is', async () => {
      const cookie = await actors.signIn(admin.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      record(
        await http()
          .get(urlPath(owner.workspaceId))
          .set('Cookie', cookie)
          .expect(200),
      );
    });

    it('409 when the workspace is not the session’s active one', async () => {
      // admin's active workspace is their own; owner.workspaceId is a second membership.
      record(
        await http()
          .get(urlPath(owner.workspaceId))
          .set('Cookie', admin.cookie)
          .expect(409),
      );
    });

    it('403 for an impersonated session (connect blocked, D5)', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      const before = states.size;
      const res = record(
        await http()
          .get(urlPath(owner.workspaceId))
          .set('Cookie', cookie)
          .expect(403),
      );
      expect(res.body.message).toMatch(/impersonat/i);
      expect(states.size).toBe(before);
    });

    it('503 when Meta is not configured, no state stored', async () => {
      graph.enabled = false;
      const before = states.size;
      record(
        await http()
          .get(urlPath(owner.workspaceId))
          .set('Cookie', owner.cookie)
          .expect(503),
      );
      expect(states.size).toBe(before);
    });
  });

  describe('GET /api/meta/oauth/callback', () => {
    it('missing state → error redirect (no session needed for the redirect)', async () => {
      expect(await callback({ code: 'x' }, owner.cookie)).toBe(
        errorRedirect('invalid_state'),
      );
      expect(await callback({})).toBe(errorRedirect('invalid_state'));
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });

    it('unknown / malformed state → invalid_state', async () => {
      expect(
        await callback({ code: 'x', state: 'A'.repeat(43) }, owner.cookie),
      ).toBe(errorRedirect('invalid_state'));
      expect(
        await callback({ code: 'x', state: 'not-a-state' }, owner.cookie),
      ).toBe(errorRedirect('invalid_state'));
    });

    it('expired state → invalid_state', async () => {
      const state = await startFlow(owner, '?returnTo=/pages');
      states.expire(state);
      armGraph();
      expect(await callback({ code: 'x', state }, owner.cookie)).toBe(
        errorRedirect('invalid_state'),
      );
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });

    it('denied consent → access_denied on the starting page, nothing stored', async () => {
      const state = await startFlow(owner, '?returnTo=/pages');
      const location = await callback(
        {
          state,
          error: 'access_denied',
          error_code: '200',
          error_reason: 'user_denied',
          error_description: 'Permissions error',
        },
        owner.cookie,
      );
      expect(location).toBe(errorRedirect('access_denied', '/pages'));
      expect(graph.exchangeCode).not.toHaveBeenCalled();
      expect(await connectionsOf(owner.workspaceId)).toHaveLength(0);
    });

    it('no session → unauthenticated redirect (client guard sends to login), state burned', async () => {
      const state = await startFlow(owner);
      expect(await callback({ code: 'x', state })).toBe(
        errorRedirect('unauthenticated'),
      );
      expect(await callback({ code: 'x', state }, owner.cookie)).toBe(
        errorRedirect('invalid_state'),
      );
    });

    it('foreign state (another user’s) → state_mismatch, and the owner can’t reuse it', async () => {
      const state = await startFlow(owner);
      armGraph();
      expect(await callback({ code: 'x', state }, other.cookie)).toBe(
        errorRedirect('state_mismatch'),
      );
      expect(graph.exchangeCode).not.toHaveBeenCalled();
      expect(await connectionsOf(other.workspaceId)).toHaveLength(0);
      expect(await callback({ code: 'x', state }, owner.cookie)).toBe(
        errorRedirect('invalid_state'),
      );
    });

    it('same user, different active workspace → state_mismatch', async () => {
      const cookie = await actors.signIn(owner.email);
      const state = await startFlow({ ...owner, cookie });
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: other.workspaceId,
      });
      expect(await callback({ code: 'x', state }, cookie)).toBe(
        errorRedirect('state_mismatch'),
      );
    });

    it('impersonated session on the callback → impersonation_blocked', async () => {
      const cookie = await actors.signIn(owner.email);
      const state = await startFlow({ ...owner, cookie });
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
      });
      armGraph();
      expect(await callback({ code: 'x', state }, cookie)).toBe(
        errorRedirect('impersonation_blocked'),
      );
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });

    it('Meta rejects the code → meta_error, nothing stored', async () => {
      const state = await startFlow(owner);
      graph.exchangeCode.mockRejectedValueOnce(
        new MetaGraphError('invalid_request', 'Meta Graph 400 (#100): bad', {
          status: 400,
          code: 100,
        }),
      );
      expect(await callback({ code: 'used', state }, owner.cookie)).toBe(
        errorRedirect('meta_error'),
      );
      expect(await connectionsOf(owner.workspaceId)).toHaveLength(0);
    });

    it('success creates one encrypted ACTIVE connection and redirects connected', async () => {
      const state = await startFlow(owner);
      const tokens = armGraph(`${base}1`);
      expect(await callback({ code: tokens.code, state }, owner.cookie)).toBe(
        `${CLIENT}/onboarding?meta=connected`,
      );
      expect(graph.exchangeCode).toHaveBeenCalledWith(tokens.code);
      expect(graph.exchangeForLongLivedToken).toHaveBeenCalledWith(
        tokens.short,
      );

      const rows = await connectionsOf(owner.workspaceId);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        facebookUserId: `${base}1`,
        status: 'ACTIVE',
        tokenExpiresAt: new Date('2027-01-17T00:00:00.000Z'),
        grantedScopes: ['pages_manage_engagement', 'pages_show_list'],
      });
      expect(row!.encryptedUserAccessToken).toMatch(/^v1:e2e:/);
      expect(row!.encryptedUserAccessToken).not.toContain(tokens.long);
      const cipher = app.get(TokenCipherService);
      expect(
        cipher.decrypt(
          row!.encryptedUserAccessToken,
          tokenCipherContext('meta_user_token', owner.workspaceId, `${base}1`),
        ),
      ).toBe(tokens.long);

      // The state was single use.
      expect(await callback({ code: tokens.code, state }, owner.cookie)).toBe(
        errorRedirect('invalid_state'),
      );
      expect(await connectionsOf(owner.workspaceId)).toHaveLength(1);
    });

    it('re-connect updates the same row (no duplicate) and reactivates it', async () => {
      const [first] = await connectionsOf(owner.workspaceId);
      expect(first).toBeDefined();
      const flagged = new Date('2026-01-01T00:00:00.000Z');
      await db()
        .update(metaConnections)
        .set({ status: 'NEEDS_REAUTH', statusChangedAt: flagged })
        .where(eq(metaConnections.workspaceId, owner.workspaceId));

      const state = await startFlow(owner, '?returnTo=/pages');
      const tokens = armGraph(`${base}2`);
      expect(await callback({ code: tokens.code, state }, owner.cookie)).toBe(
        `${CLIENT}/pages?meta=connected`,
      );

      const rows = await connectionsOf(owner.workspaceId);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row!.id).toBe(first!.id);
      expect(row!.createdAt).toEqual(first!.createdAt);
      expect(row!.facebookUserId).toBe(`${base}2`);
      expect(row!.status).toBe('ACTIVE');
      expect(row!.statusChangedAt.getTime()).toBeGreaterThan(flagged.getTime());
      expect(row!.encryptedUserAccessToken).not.toBe(
        first!.encryptedUserAccessToken,
      );
      expect(
        app
          .get(TokenCipherService)
          .decrypt(
            row!.encryptedUserAccessToken,
            tokenCipherContext(
              'meta_user_token',
              owner.workspaceId,
              `${base}2`,
            ),
          ),
      ).toBe(tokens.long);
    });

    it('re-connect while ACTIVE keeps status_changed_at', async () => {
      const [before] = await connectionsOf(owner.workspaceId);
      const state = await startFlow(owner);
      const tokens = armGraph(`${base}2`);
      await callback({ code: tokens.code, state }, owner.cookie);
      const [after] = await connectionsOf(owner.workspaceId);
      expect(after!.statusChangedAt).toEqual(before!.statusChangedAt);
      expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        before!.updatedAt.getTime(),
      );
    });

    it('another workspace can’t read or reuse the connection', async () => {
      const [ownerRow] = await connectionsOf(owner.workspaceId);
      // The ciphertext is bound to its workspace: decrypting as another workspace fails.
      expect(() =>
        app
          .get(TokenCipherService)
          .decrypt(
            ownerRow!.encryptedUserAccessToken,
            tokenCipherContext(
              'meta_user_token',
              other.workspaceId,
              `${base}2`,
            ),
          ),
      ).toThrow();
      // Other workspace connects its own: a separate row, the owner's untouched.
      const state = await startFlow(other);
      const tokens = armGraph(`${base}3`);
      expect(await callback({ code: tokens.code, state }, other.cookie)).toBe(
        `${CLIENT}/onboarding?meta=connected`,
      );
      const rows = await db()
        .select()
        .from(metaConnections)
        .where(
          inArray(metaConnections.workspaceId, [
            owner.workspaceId,
            other.workspaceId,
          ]),
        );
      expect(rows).toHaveLength(2);
      const [ownerAfter] = await connectionsOf(owner.workspaceId);
      expect(ownerAfter).toEqual(ownerRow);
    });

    it('tokens and codes never appear in any response', () => {
      const all = seen.join('\n');
      expect(seen.length).toBeGreaterThan(20);
      expect(all).not.toMatch(/EAA(short|long)/);
      expect(all).not.toContain('AQD-code-');
      expect(all).not.toContain('v1:e2e:');
    });
  });
});
