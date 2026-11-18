import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthSession } from '../auth/auth-session.js';
import { findWorkspaceMembership } from '../auth/authz-queries.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../crypto/token-cipher.service.js';
import { buildTokenKeyring } from '../crypto/token-keyring.js';
import type { Database } from '../db/database.js';
import { upsertMetaConnection } from './meta-connection.queries.js';
import type { MetaGraphClient } from './meta-graph.client.js';
import { MetaGraphError, MetaNotConfiguredError } from './meta-graph.errors.js';
import type { MetaOAuthStateData } from './meta-oauth-state.js';
import type { MetaOAuthStateStore } from './meta-oauth-state.store.js';
import { MetaOAuthService } from './meta-oauth.service.js';
import { syncSocialPages } from './social-pages.sync.js';

vi.mock('../auth/authz-queries.js', () => ({
  findWorkspaceMembership: vi.fn(),
}));
vi.mock('./meta-connection.queries.js', () => ({
  upsertMetaConnection: vi.fn(),
}));
vi.mock('./social-pages.sync.js', () => ({
  syncSocialPages: vi.fn(),
}));

const WS = '0192f5a4-7c3e-7a10-8b2c-3d4e5f6a7b8c';
const USER = 'user-1';
const STATE = 'S'.repeat(43);
const CODE = 'AQD-oauth-code-secret';
const SHORT = 'EAAshort-lived-token';
const LONG = 'EAAlong-lived-token';
const FB_USER = '1234567890';
const ORIGIN = 'http://app.localhost:5174';
const PAGE_A = '1111111111';
const PAGE_B = '2222222222';
const IG_A = '17841400000000001';
const PAGE_TOKEN_A = 'EAApage-token-a';
const PAGE_TOKEN_B = 'EAApage-token-b';
const PAGES = [
  {
    id: PAGE_A,
    name: 'Shop A',
    accessToken: PAGE_TOKEN_A,
    instagram: { id: IG_A, username: 'shop.a' },
  },
  { id: PAGE_B, name: 'Shop B', accessToken: PAGE_TOKEN_B, instagram: null },
];
const NO_SYNC = { created: 0, updated: 0, deactivated: 0, skipped: [] };

function session(patch: Record<string, unknown> = {}): AuthSession {
  return {
    user: { id: USER },
    session: { activeOrganizationId: WS, impersonatedBy: null, ...patch },
  } as unknown as AuthSession;
}

const cipherKey = randomBytes(32).toString('base64');

function setup(
  opts: { graphEnabled?: boolean; cipherConfigured?: boolean } = {},
) {
  const graph = {
    enabled: opts.graphEnabled ?? true,
    buildLoginUrl: vi.fn(
      (state: string) =>
        `https://www.facebook.com/v26.0/dialog/oauth?state=${state}`,
    ),
    exchangeCode: vi
      .fn()
      .mockResolvedValue({ accessToken: SHORT, expiresAt: null }),
    exchangeForLongLivedToken: vi.fn().mockResolvedValue({
      accessToken: LONG,
      expiresAt: new Date('2027-01-17T00:00:00Z'),
    }),
    getMe: vi.fn().mockResolvedValue({ id: FB_USER, name: 'Owner' }),
    getPermissions: vi.fn().mockResolvedValue({
      granted: ['pages_show_list', 'business_management', 'pages_show_list'],
      declined: ['instagram_basic'],
    }),
    getPages: vi.fn().mockResolvedValue(PAGES),
  };
  const tx = { tx: true };
  const db = {
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const stored = new Map<string, MetaOAuthStateData>();
  const states = {
    save: vi.fn(async (state: string, data: MetaOAuthStateData) => {
      stored.set(state, data);
    }),
    take: vi.fn(async (state: string) => {
      const data = stored.get(state) ?? null;
      stored.delete(state);
      return data;
    }),
  };
  const cipher = new TokenCipherService(
    opts.cipherConfigured === false
      ? null
      : buildTokenKeyring({ key: cipherKey, keyId: 'unit' }),
  );
  const config = {
    get: vi.fn(() => ORIGIN),
  } as unknown as ConfigService<EnvironmentVariables, true>;
  const service = new MetaOAuthService(
    db as unknown as Database,
    graph as unknown as MetaGraphClient,
    cipher,
    states as unknown as MetaOAuthStateStore,
    config,
  );
  const begin = (data: Partial<MetaOAuthStateData> = {}) =>
    stored.set(STATE, {
      userId: USER,
      workspaceId: WS,
      returnTo: '/onboarding',
      ...data,
    });
  return { service, graph, states, stored, cipher, begin, db, tx };
}

const error = (reason: string, path = '/onboarding') =>
  `${ORIGIN}${path}?meta=error&reason=${reason}`;

describe('MetaOAuthService', () => {
  beforeEach(() => {
    vi.mocked(findWorkspaceMembership).mockReset();
    vi.mocked(findWorkspaceMembership).mockResolvedValue({
      role: 'owner',
      status: 'ACTIVE',
    });
    vi.mocked(upsertMetaConnection).mockReset();
    vi.mocked(upsertMetaConnection).mockResolvedValue({ id: 'conn-1' });
    vi.mocked(syncSocialPages).mockReset();
    vi.mocked(syncSocialPages).mockResolvedValue(NO_SYNC);
  });

  describe('createLoginUrl', () => {
    const workspace = { id: WS, role: 'owner' as const };

    it('stores a fresh state bound to user + workspace + returnTo and returns the dialog URL', async () => {
      const { service, states, graph } = setup();
      const result = await service.createLoginUrl(
        session(),
        workspace,
        '/pages',
      );
      expect(Object.keys(result)).toEqual(['url']);
      const [state, data, ttl] = states.save.mock.calls[0]!;
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(data).toEqual({
        userId: USER,
        workspaceId: WS,
        returnTo: '/pages',
      });
      expect(ttl).toBe(600);
      expect(graph.buildLoginUrl).toHaveBeenCalledWith(state);
      expect(result.url).toContain(`state=${state}`);
    });

    it('defaults returnTo to /onboarding', async () => {
      const { service, states } = setup();
      await service.createLoginUrl(session(), workspace);
      expect(states.save.mock.calls[0]![1].returnTo).toBe('/onboarding');
    });

    it('403 for an impersonated session, no state stored', async () => {
      const { service, states } = setup();
      await expect(
        service.createLoginUrl(
          session({ impersonatedBy: 'admin-1' }),
          workspace,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(states.save).not.toHaveBeenCalled();
    });

    it('409 when the workspace is not the session’s active one', async () => {
      const { service } = setup();
      await expect(
        service.createLoginUrl(
          session({
            activeOrganizationId: '0192f5a4-0000-7000-8000-000000000000',
          }),
          workspace,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('matches the active workspace case-insensitively', async () => {
      const { service } = setup();
      await expect(
        service.createLoginUrl(
          session({ activeOrganizationId: WS.toUpperCase() }),
          workspace,
        ),
      ).resolves.toHaveProperty('url');
    });

    it.each([
      ['Meta app', { graphEnabled: false }],
      ['token cipher', { cipherConfigured: false }],
    ])('503 when the %s is not configured', async (_what, opts) => {
      const { service, states } = setup(opts);
      expect(service.configured).toBe(false);
      await expect(
        service.createLoginUrl(session(), workspace),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(states.save).not.toHaveBeenCalled();
    });
  });

  describe('handleCallback', () => {
    it('connects: exchanges, encrypts the long-lived token, upserts, redirects connected', async () => {
      const { service, graph, cipher, begin, stored } = setup();
      begin({ returnTo: '/pages' });
      const url = await service.handleCallback(
        { code: CODE, state: STATE },
        session(),
      );
      expect(url).toBe(`${ORIGIN}/pages?meta=connected`);
      expect(stored.size).toBe(0);
      expect(graph.exchangeCode).toHaveBeenCalledWith(CODE);
      expect(graph.exchangeForLongLivedToken).toHaveBeenCalledWith(SHORT);
      expect(graph.getMe).toHaveBeenCalledWith(LONG);
      expect(graph.getPermissions).toHaveBeenCalledWith(LONG);

      const [, values] = vi.mocked(upsertMetaConnection).mock.calls[0]!;
      expect(values).toMatchObject({
        workspaceId: WS,
        facebookUserId: FB_USER,
        tokenExpiresAt: new Date('2027-01-17T00:00:00Z'),
        grantedScopes: ['business_management', 'pages_show_list'],
      });
      expect(values.encryptedUserAccessToken).toMatch(/^v1:unit:/);
      expect(values.encryptedUserAccessToken).not.toContain(LONG);
      expect(
        cipher.decrypt(
          values.encryptedUserAccessToken,
          tokenCipherContext('meta_user_token', WS, FB_USER),
        ),
      ).toBe(LONG);
    });

    it('syncs every Page (+ IG account) with Page tokens encrypted per workspace + Page, in the same tx', async () => {
      const { service, graph, cipher, begin, db, tx } = setup();
      begin();
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(`${ORIGIN}/onboarding?meta=connected`);
      expect(graph.getPages).toHaveBeenCalledWith(LONG);
      expect(db.transaction).toHaveBeenCalledOnce();
      expect(vi.mocked(upsertMetaConnection).mock.calls[0]![0]).toBe(tx);

      const [executor, workspaceId, rows] =
        vi.mocked(syncSocialPages).mock.calls[0]!;
      expect(executor).toBe(tx);
      expect(workspaceId).toBe(WS);
      expect(
        rows.map(({ encryptedPageAccessToken: _t, ...rest }) => rest),
      ).toEqual([
        {
          pageId: PAGE_A,
          pageName: 'Shop A',
          igBusinessId: IG_A,
          igUsername: 'shop.a',
        },
        {
          pageId: PAGE_B,
          pageName: 'Shop B',
          igBusinessId: null,
          igUsername: null,
        },
      ]);
      const [a, b] = rows;
      expect(a!.encryptedPageAccessToken).toMatch(/^v1:unit:/);
      expect(a!.encryptedPageAccessToken).not.toContain(PAGE_TOKEN_A);
      expect(
        cipher.decrypt(
          a!.encryptedPageAccessToken,
          tokenCipherContext('meta_page_token', WS, PAGE_A),
        ),
      ).toBe(PAGE_TOKEN_A);
      expect(
        cipher.decrypt(
          b!.encryptedPageAccessToken,
          tokenCipherContext('meta_page_token', WS, PAGE_B),
        ),
      ).toBe(PAGE_TOKEN_B);
      // Bound to its Page: another Page id (or the user-token purpose) can't decrypt it.
      expect(() =>
        cipher.decrypt(
          a!.encryptedPageAccessToken,
          tokenCipherContext('meta_page_token', WS, PAGE_B),
        ),
      ).toThrow();
      expect(() =>
        cipher.decrypt(
          a!.encryptedPageAccessToken,
          tokenCipherContext('meta_user_token', WS, PAGE_A),
        ),
      ).toThrow();
    });

    it('a user with no Pages still connects (empty sync)', async () => {
      const { service, graph, begin } = setup();
      begin();
      graph.getPages.mockResolvedValue([]);
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(`${ORIGIN}/onboarding?meta=connected`);
      expect(vi.mocked(syncSocialPages).mock.calls[0]![2]).toEqual([]);
    });

    it('reports skipped Pages as &skipped=N', async () => {
      const { service, begin } = setup();
      begin({ returnTo: '/pages' });
      vi.mocked(syncSocialPages).mockResolvedValue({
        ...NO_SYNC,
        created: 1,
        skipped: [
          { pageId: PAGE_A, reason: 'page_in_other_workspace' },
          { pageId: PAGE_B, reason: 'instagram_in_other_workspace' },
        ],
      });
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(`${ORIGIN}/pages?meta=connected&skipped=2`);
    });

    it.each([
      ['rate_limited', 'meta_unavailable'],
      ['token_invalid', 'meta_error'],
      ['unexpected_response', 'meta_error'],
    ] as const)(
      'getPages %s → %s, no transaction (connection not written either)',
      async (kind, reason) => {
        const { service, begin, graph, db } = setup();
        begin();
        graph.getPages.mockRejectedValue(
          new MetaGraphError(kind, 'Meta Graph 400: bad', { status: 400 }),
        );
        expect(
          await service.handleCallback({ code: CODE, state: STATE }, session()),
        ).toBe(error(reason));
        expect(db.transaction).not.toHaveBeenCalled();
        expect(upsertMetaConnection).not.toHaveBeenCalled();
        expect(syncSocialPages).not.toHaveBeenCalled();
      },
    );

    it('server_error when the Page sync fails (the tx rolls back the connection)', async () => {
      const { service, begin, db } = setup();
      begin();
      vi.mocked(syncSocialPages).mockRejectedValue(
        Object.assign(new Error('insert failed'), {
          cause: { code: '23505' },
        }),
      );
      await expect(
        service.handleCallback({ code: CODE, state: STATE }, session()),
      ).resolves.toBe(error('server_error'));
      await expect(db.transaction.mock.results[0]!.value).rejects.toThrow();
    });

    it('checks membership in the state’s workspace for the session user', async () => {
      const { service, begin } = setup();
      begin();
      await service.handleCallback({ code: CODE, state: STATE }, session());
      expect(findWorkspaceMembership).toHaveBeenCalledWith(
        expect.anything(),
        WS,
        USER,
      );
    });

    it.each([
      ['missing', {}],
      ['malformed', { state: 'nope' }],
      ['array', { state: [STATE, STATE] }],
    ])('invalid_state for a %s state, Redis untouched', async (_k, query) => {
      const { service, states } = setup();
      expect(
        await service.handleCallback({ code: CODE, ...query }, session()),
      ).toBe(error('invalid_state'));
      expect(states.take).not.toHaveBeenCalled();
    });

    it('invalid_state for an unknown/expired state', async () => {
      const { service, graph } = setup();
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(error('invalid_state'));
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });

    it('a state works once: the second callback is invalid_state', async () => {
      const { service, begin } = setup();
      begin();
      await service.handleCallback({ code: CODE, state: STATE }, session());
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(error('invalid_state'));
      expect(upsertMetaConnection).toHaveBeenCalledOnce();
    });

    it('access_denied when the user cancels, state burned, no exchange', async () => {
      const { service, begin, stored, graph } = setup();
      begin({ returnTo: '/pages' });
      const url = await service.handleCallback(
        {
          state: STATE,
          error: 'access_denied',
          error_reason: 'user_denied',
          error_description: 'Permissions error',
        },
        session(),
      );
      expect(url).toBe(error('access_denied', '/pages'));
      expect(stored.size).toBe(0);
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });

    it('meta_error for another dialog error', async () => {
      const { service, begin } = setup();
      begin();
      expect(
        await service.handleCallback(
          { state: STATE, error: 'server_error' },
          session(),
        ),
      ).toBe(error('meta_error'));
    });

    it('unauthenticated without a session (state still burned)', async () => {
      const { service, begin, stored } = setup();
      begin({ returnTo: '/pages' });
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, null),
      ).toBe(error('unauthenticated', '/pages'));
      expect(stored.size).toBe(0);
    });

    it('impersonation_blocked for an impersonated session', async () => {
      const { service, begin, graph } = setup();
      begin();
      expect(
        await service.handleCallback(
          { code: CODE, state: STATE },
          session({ impersonatedBy: 'admin-1' }),
        ),
      ).toBe(error('impersonation_blocked'));
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });

    it.each([
      ['another user', { userId: 'user-2' }],
      [
        'another workspace',
        { workspaceId: '0192f5a4-0000-7000-8000-000000000000' },
      ],
    ])('state_mismatch when the state belongs to %s', async (_k, data) => {
      const { service, begin, graph } = setup();
      begin(data);
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(error('state_mismatch'));
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });

    it.each([
      ['no longer a member', undefined],
      ['now a moderator', { role: 'moderator', status: 'ACTIVE' }],
      ['suspended', { role: 'owner', status: 'SUSPENDED' }],
    ] as const)('forbidden when %s', async (_k, membership) => {
      const { service, begin, graph } = setup();
      begin();
      vi.mocked(findWorkspaceMembership).mockResolvedValue(membership);
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(error('forbidden'));
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });

    it('admins may connect too', async () => {
      const { service, begin } = setup();
      begin();
      vi.mocked(findWorkspaceMembership).mockResolvedValue({
        role: 'admin',
        status: 'ACTIVE',
      });
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(`${ORIGIN}/onboarding?meta=connected`);
    });

    it('missing_code without code or error', async () => {
      const { service, begin } = setup();
      begin();
      expect(await service.handleCallback({ state: STATE }, session())).toBe(
        error('missing_code'),
      );
    });

    it.each([[{ graphEnabled: false }], [{ cipherConfigured: false }]])(
      'not_configured (%o)',
      async (opts) => {
        const { service, begin, graph } = setup(opts);
        begin();
        expect(
          await service.handleCallback({ code: CODE, state: STATE }, session()),
        ).toBe(error('not_configured'));
        expect(graph.exchangeCode).not.toHaveBeenCalled();
      },
    );

    it('not_configured when the client throws MetaNotConfiguredError', async () => {
      const { service, begin, graph } = setup();
      begin();
      graph.exchangeCode.mockRejectedValue(new MetaNotConfiguredError());
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(error('not_configured'));
    });

    it.each([
      ['invalid_request', 'meta_error'],
      ['permission', 'meta_error'],
      ['token_invalid', 'meta_error'],
      ['unexpected_response', 'meta_error'],
      ['rate_limited', 'meta_unavailable'],
      ['transient', 'meta_unavailable'],
      ['network', 'meta_unavailable'],
    ] as const)('Graph %s → %s, nothing stored', async (kind, reason) => {
      const { service, begin, graph } = setup();
      begin();
      graph.exchangeForLongLivedToken.mockRejectedValue(
        new MetaGraphError(kind, 'Meta Graph 400 (#100): bad', {
          status: 400,
          code: 100,
        }),
      );
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(error(reason));
      expect(upsertMetaConnection).not.toHaveBeenCalled();
    });

    it('server_error when the state store or DB fails', async () => {
      const { service, begin, states } = setup();
      states.take.mockRejectedValueOnce(new Error('redis down'));
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(error('server_error'));

      begin();
      vi.mocked(upsertMetaConnection).mockRejectedValue(new Error('db down'));
      expect(
        await service.handleCallback({ code: CODE, state: STATE }, session()),
      ).toBe(error('server_error'));
    });

    it('never logs tokens, codes or states', async () => {
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) =>
          vi.spyOn(Logger.prototype, level).mockImplementation(() => {}),
      );
      try {
        const { service, begin, graph } = setup();
        begin();
        vi.mocked(syncSocialPages).mockResolvedValueOnce({
          created: 1,
          updated: 0,
          deactivated: 1,
          skipped: [{ pageId: PAGE_B, reason: 'page_in_other_workspace' }],
        });
        await service.handleCallback({ code: CODE, state: STATE }, session());
        begin();
        graph.exchangeCode.mockRejectedValueOnce(
          new MetaGraphError('invalid_request', 'Meta Graph 400: bad code', {
            status: 400,
            code: 100,
          }),
        );
        await service.handleCallback({ code: CODE, state: STATE }, session());
        begin();
        vi.mocked(upsertMetaConnection).mockRejectedValueOnce(
          new Error(`boom ${LONG}`),
        );
        await service.handleCallback({ code: CODE, state: STATE }, session());

        const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
        expect(logged.length).toBeGreaterThan(2);
        for (const secret of [
          CODE,
          STATE,
          SHORT,
          LONG,
          PAGE_TOKEN_A,
          PAGE_TOKEN_B,
          'EAA',
          'v1:unit:',
          'Shop A',
        ]) {
          expect(logged).not.toContain(secret);
        }
        expect(logged).toContain(
          'pages created=1 updated=0 deactivated=1 skipped=1',
        );
        expect(logged).toContain(`${PAGE_B}:page_in_other_workspace`);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});
