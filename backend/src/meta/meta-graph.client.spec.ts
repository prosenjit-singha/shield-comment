import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { appSecretProof, MetaGraphClient } from './meta-graph.client.js';
import {
  createMetaAppConfig,
  DEFAULT_GRAPH_API_VERSION,
  type MetaAppConfig,
} from './meta-graph.config.js';
import { MetaGraphError, MetaNotConfiguredError } from './meta-graph.errors.js';

const CONFIG: MetaAppConfig = {
  appId: '1234567890',
  appSecret: 'app-secret-0123456789abcdef',
  loginConfigId: '987654321',
  redirectUri: 'http://app.localhost:5174/api/meta/oauth/callback',
  graphApiVersion: 'v26.0',
};
const USER_TOKEN = 'EAAGuserTokenAbcdefghijklmnopqrstuvwxyz0123';
const PAGE_TOKEN = 'EAAGpageTokenAbcdefghijklmnopqrstuvwxyz0123';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function graphError(status: number, error: Record<string, unknown>): Response {
  return jsonResponse(status, { error });
}

describe('MetaGraphClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const client = new MetaGraphClient(CONFIG);
  const debugSpy = vi
    .spyOn(Logger.prototype, 'debug')
    .mockImplementation(() => undefined);
  beforeEach(() => {
    fetchMock.mockReset();
    debugSpy.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    // Logs carry path + status + time only: never a token, the secret or the query string.
    for (const args of debugSpy.mock.calls) {
      const line = args.map(String).join(' ');
      expect(line).not.toContain(USER_TOKEN);
      expect(line).not.toContain(CONFIG.appSecret);
      expect(line).not.toContain('?');
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  afterAll(() => debugSpy.mockRestore());

  it('logs each request as path, status and duration', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: '1', name: 'x' }));
    await client.getMe(USER_TOKEN);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^GET \/me 200 \d+ms$/),
    );
  });

  /** URL of the n-th fetch call. */
  const calledUrl = (n = 0) => {
    const input = fetchMock.mock.calls[n]![0];
    return new URL(input instanceof Request ? input.url : input);
  };

  async function caught(promise: Promise<unknown>): Promise<MetaGraphError> {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MetaGraphError);
    return error as MetaGraphError;
  }

  describe('disabled', () => {
    const off = new MetaGraphClient(null);

    it('reports disabled and throws MetaNotConfiguredError without calling fetch', async () => {
      expect(off.enabled).toBe(false);
      expect(off.graphApiVersion).toBeNull();
      expect(() => off.buildLoginUrl('s')).toThrow(MetaNotConfiguredError);
      await expect(off.exchangeCode('c')).rejects.toBeInstanceOf(
        MetaNotConfiguredError,
      );
      await expect(off.getMe(USER_TOKEN)).rejects.toBeInstanceOf(
        MetaNotConfiguredError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('buildLoginUrl', () => {
    it('builds the Login for Business dialog URL with config_id and no scope', () => {
      const url = new URL(client.buildLoginUrl('state-123'));
      expect(url.origin + url.pathname).toBe(
        'https://www.facebook.com/v26.0/dialog/oauth',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: CONFIG.appId,
        redirect_uri: CONFIG.redirectUri,
        state: 'state-123',
        config_id: CONFIG.loginConfigId,
        response_type: 'code',
        override_default_response_type: 'true',
      });
      expect(url.toString()).not.toContain(CONFIG.appSecret);
    });

    it('rejects an empty state', () => {
      expect(() => client.buildLoginUrl('')).toThrow('state');
    });
  });

  describe('exchangeCode', () => {
    it('exchanges the code at the pinned version and computes expiresAt', async () => {
      vi.useFakeTimers({ now: new Date('2026-11-18T00:00:00Z') });
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          access_token: 'short',
          token_type: 'bearer',
          expires_in: 3600,
        }),
      );
      await expect(client.exchangeCode('the-code')).resolves.toEqual({
        accessToken: 'short',
        expiresAt: new Date('2026-11-18T01:00:00Z'),
      });
      const url = calledUrl();
      expect(url.origin + url.pathname).toBe(
        'https://graph.facebook.com/v26.0/oauth/access_token',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: CONFIG.appId,
        redirect_uri: CONFIG.redirectUri,
        client_secret: CONFIG.appSecret,
        code: 'the-code',
      });
    });

    it('maps a used/invalid code (#100) to invalid_request without echoing the code or secret', async () => {
      fetchMock.mockResolvedValue(
        graphError(400, {
          message: `This authorization code has been used: the-code-xyz (secret ${CONFIG.appSecret})`,
          type: 'OAuthException',
          code: 100,
          error_subcode: 36009,
          fbtrace_id: 'Abc123',
        }),
      );
      const error = await caught(client.exchangeCode('the-code-xyz'));
      expect(error).toMatchObject({
        kind: 'invalid_request',
        status: 400,
        code: 100,
        subcode: 36009,
        type: 'OAuthException',
        fbtraceId: 'Abc123',
        retryable: false,
      });
      expect(error.message).toContain('(#100/36009)');
      expect(error.message).not.toContain('the-code-xyz');
      expect(error.message).not.toContain(CONFIG.appSecret);
    });

    it('rejects an empty code and a body without access_token', async () => {
      await expect(client.exchangeCode('')).rejects.toThrow('code');
      fetchMock.mockResolvedValue(jsonResponse(200, { token_type: 'bearer' }));
      expect(await caught(client.exchangeCode('c'))).toMatchObject({
        kind: 'unexpected_response',
      });
    });
  });

  describe('exchangeForLongLivedToken', () => {
    it('uses fb_exchange_token and keeps expiresAt null without expires_in', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { access_token: 'long', token_type: 'bearer' }),
      );
      await expect(client.exchangeForLongLivedToken('short')).resolves.toEqual({
        accessToken: 'long',
        expiresAt: null,
      });
      expect(Object.fromEntries(calledUrl().searchParams)).toEqual({
        grant_type: 'fb_exchange_token',
        client_id: CONFIG.appId,
        client_secret: CONFIG.appSecret,
        fb_exchange_token: 'short',
      });
    });

    it('treats expires_in 0 as no expiry and ~60 days as a date', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'a', expires_in: 0 }),
      );
      expect(
        (await client.exchangeForLongLivedToken('s')).expiresAt,
      ).toBeNull();
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'b', expires_in: 5_183_944 }),
      );
      const { expiresAt } = await client.exchangeForLongLivedToken('s');
      const days = (expiresAt!.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(59.9);
      expect(days).toBeLessThan(60.1);
    });
  });

  describe('token calls', () => {
    it('getMe sends access_token + appsecret_proof (HMAC-SHA256 of the token)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { id: '10220000000000001', name: 'Rahim' }),
      );
      await expect(client.getMe(USER_TOKEN)).resolves.toEqual({
        id: '10220000000000001',
        name: 'Rahim',
      });
      const url = calledUrl();
      expect(url.pathname).toBe('/v26.0/me');
      expect(url.searchParams.get('fields')).toBe('id,name');
      expect(url.searchParams.get('access_token')).toBe(USER_TOKEN);
      expect(url.searchParams.get('appsecret_proof')).toBe(
        createHmac('sha256', CONFIG.appSecret).update(USER_TOKEN).digest('hex'),
      );
      expect(url.searchParams.has('client_secret')).toBe(false);
    });

    it('getMe rejects a body without a numeric id', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { name: 'x' }));
      expect(await caught(client.getMe(USER_TOKEN))).toMatchObject({
        kind: 'unexpected_response',
      });
    });

    it('getPermissions splits granted from declined/expired', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          data: [
            { permission: 'pages_show_list', status: 'granted' },
            { permission: 'instagram_manage_comments', status: 'declined' },
            { permission: 'pages_manage_metadata', status: 'expired' },
            { permission: 'business_management', status: 'granted' },
            { status: 'granted' },
          ],
        }),
      );
      await expect(client.getPermissions(USER_TOKEN)).resolves.toEqual({
        granted: ['pages_show_list', 'business_management'],
        declined: ['instagram_manage_comments', 'pages_manage_metadata'],
      });
      expect(calledUrl().pathname).toBe('/v26.0/me/permissions');
    });

    it('rejects an empty token without calling fetch', async () => {
      await expect(client.getPages('')).rejects.toThrow('Token');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getPages', () => {
    const page = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: `Page ${id}`,
      access_token: PAGE_TOKEN,
      ...extra,
    });

    it('maps Pages with and without a linked IG account', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          data: [
            page('111', {
              instagram_business_account: {
                id: '17841400000000001',
                username: 'shop.bd',
              },
            }),
            page('222'),
            page('333', {
              instagram_business_account: { id: '17841400000000002' },
            }),
          ],
        }),
      );
      await expect(client.getPages(USER_TOKEN)).resolves.toEqual([
        {
          id: '111',
          name: 'Page 111',
          accessToken: PAGE_TOKEN,
          instagram: { id: '17841400000000001', username: 'shop.bd' },
        },
        {
          id: '222',
          name: 'Page 222',
          accessToken: PAGE_TOKEN,
          instagram: null,
        },
        {
          id: '333',
          name: 'Page 333',
          accessToken: PAGE_TOKEN,
          instagram: { id: '17841400000000002', username: null },
        },
      ]);
      const url = calledUrl();
      expect(url.pathname).toBe('/v26.0/me/accounts');
      expect(url.searchParams.get('fields')).toBe(
        'id,name,access_token,instagram_business_account{id,username}',
      );
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.has('after')).toBe(false);
    });

    it('follows the after cursor while paging.next exists', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: [page('111')],
            paging: {
              cursors: { before: 'b1', after: 'cur-1' },
              next: 'https://graph.facebook.com/v26.0/me/accounts?after=cur-1',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: [page('222')],
            paging: { cursors: { before: 'b2', after: 'cur-2' } },
          }),
        );
      const pages = await client.getPages(USER_TOKEN);
      expect(pages.map((p) => p.id)).toEqual(['111', '222']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = calledUrl(1);
      expect(second.searchParams.get('after')).toBe('cur-1');
      // Our own URL, not Meta's `next` link, and still signed.
      expect(second.searchParams.get('appsecret_proof')).toBe(
        appSecretProof(USER_TOKEN, CONFIG.appSecret),
      );
    });

    it('returns [] for a user without Pages', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
      await expect(client.getPages(USER_TOKEN)).resolves.toEqual([]);
    });

    it('throws instead of returning a partial list when paging never ends', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse(200, {
            data: [],
            paging: { cursors: { after: 'again' }, next: 'https://x' },
          }),
        ),
      );
      expect(await caught(client.getPages(USER_TOKEN))).toMatchObject({
        kind: 'unexpected_response',
      });
      expect(fetchMock).toHaveBeenCalledTimes(50);
    });

    it.each([
      ['no data array', { pages: [] }],
      ['non-numeric Page id', { data: [page('abc')] }],
      ['missing Page token', { data: [{ id: '111', name: 'x' }] }],
      [
        'bad IG account',
        { data: [page('111', { instagram_business_account: { id: 'ig' } })] },
      ],
    ])('rejects a body with %s', async (_label, body) => {
      fetchMock.mockResolvedValue(jsonResponse(200, body));
      expect(await caught(client.getPages(USER_TOKEN))).toMatchObject({
        kind: 'unexpected_response',
      });
    });
  });

  describe('debugToken', () => {
    const APP_TOKEN = `${CONFIG.appId}|${CONFIG.appSecret}`;

    it('calls /debug_token with the app access token, no appsecret_proof', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          data: {
            app_id: CONFIG.appId,
            type: 'USER',
            is_valid: true,
            expires_at: 1_800_000_000,
            data_access_expires_at: 1_810_000_000,
            scopes: ['pages_show_list', 'instagram_basic'],
            user_id: '10000000000001',
          },
        }),
      );
      const info = await client.debugToken(USER_TOKEN);
      expect(info).toEqual({
        isValid: true,
        expiresAt: new Date(1_800_000_000_000),
        scopes: ['pages_show_list', 'instagram_basic'],
      });
      const url = calledUrl();
      expect(url.origin + url.pathname).toBe(
        `https://graph.facebook.com/${CONFIG.graphApiVersion}/debug_token`,
      );
      expect(url.searchParams.get('input_token')).toBe(USER_TOKEN);
      expect(url.searchParams.get('access_token')).toBe(APP_TOKEN);
      expect(url.searchParams.has('appsecret_proof')).toBe(false);
    });

    it('an invalid token is a result (is_valid false), not an error', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          data: {
            is_valid: false,
            expires_at: 0,
            error: { code: 190, subcode: 460, message: 'Session invalid' },
          },
        }),
      );
      expect(await client.debugToken(USER_TOKEN)).toEqual({
        isValid: false,
        expiresAt: null,
        scopes: [],
      });
    });

    it('drops non-string scopes and treats expires_at 0 as no expiry', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          data: { is_valid: true, expires_at: 0, scopes: ['a', 7, '', null] },
        }),
      );
      expect(await client.debugToken(USER_TOKEN)).toEqual({
        isValid: true,
        expiresAt: null,
        scopes: ['a'],
      });
    });

    it.each([[{}], [{ data: null }], [{ data: { is_valid: 'yes' } }], [[]]])(
      'a body like %j is unexpected_response',
      async (body) => {
        fetchMock.mockResolvedValue(jsonResponse(200, body));
        expect(await caught(client.debugToken(USER_TOKEN))).toMatchObject({
          kind: 'unexpected_response',
        });
      },
    );

    it.each([
      [190, 'token_invalid', false],
      [4, 'rate_limited', true],
      [1, 'transient', true],
    ] as const)(
      'Graph error #%i → %s, app secret + tokens scrubbed',
      async (code, kind, retryable) => {
        fetchMock.mockResolvedValue(
          graphError(400, {
            message: `Bad ${APP_TOKEN} / ${CONFIG.appSecret} / ${USER_TOKEN}`,
            code,
          }),
        );
        const error = await caught(client.debugToken(USER_TOKEN));
        expect(error).toMatchObject({ kind, retryable });
        expect(error.message).not.toContain(CONFIG.appSecret);
        expect(error.message).not.toContain(USER_TOKEN);
        expect(error.message).not.toContain(CONFIG.appId + '|');
      },
    );

    it('network failure → network error without the URL', async () => {
      fetchMock.mockRejectedValue(new TypeError(`failed ${APP_TOKEN}`));
      const error = await caught(client.debugToken(USER_TOKEN));
      expect(error).toMatchObject({ kind: 'network', retryable: true });
      expect(error.message).not.toContain(CONFIG.appSecret);
    });

    it('rejects an empty token without calling fetch', async () => {
      await expect(client.debugToken('')).rejects.toThrow('Token');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('subscribePageApp / unsubscribePageApp (M4-T8)', () => {
    const PAGE_ID = '1010000000000001';
    const proof = createHmac('sha256', CONFIG.appSecret)
      .update(PAGE_TOKEN)
      .digest('hex');
    const init = (n = 0) => fetchMock.mock.calls[n]![1]!;

    it('subscribe = POST /{page-id}/subscribed_apps, form body with feed + Page token + proof', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));
      await expect(
        client.subscribePageApp(PAGE_ID, PAGE_TOKEN),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = calledUrl();
      expect(url.origin + url.pathname).toBe(
        `https://graph.facebook.com/v26.0/${PAGE_ID}/subscribed_apps`,
      );
      // Nothing in the URL: the token travels in the body.
      expect(url.search).toBe('');
      expect(init().method).toBe('POST');
      expect(init().headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      const sent = init().body;
      expect(typeof sent).toBe('string');
      const body = new URLSearchParams(sent as string);
      expect(Object.fromEntries(body)).toEqual({
        subscribed_fields: 'feed',
        access_token: PAGE_TOKEN,
        appsecret_proof: proof,
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^POST /${PAGE_ID}/subscribed_apps 200 \\d+ms$`),
        ),
      );
    });

    it('unsubscribe = DELETE /{page-id}/subscribed_apps with token + proof in the query', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));
      await expect(
        client.unsubscribePageApp(PAGE_ID, PAGE_TOKEN),
      ).resolves.toBeUndefined();
      const url = calledUrl();
      expect(url.pathname).toBe(`/v26.0/${PAGE_ID}/subscribed_apps`);
      expect(init().method).toBe('DELETE');
      expect(init().body).toBeUndefined();
      expect(url.searchParams.get('access_token')).toBe(PAGE_TOKEN);
      expect(url.searchParams.get('appsecret_proof')).toBe(proof);
      expect(url.searchParams.has('subscribed_fields')).toBe(false);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^DELETE \/\d+\/subscribed_apps 200 \d+ms$/),
      );
    });

    it.each([[{ success: false }], [{}], [{ success: 'true' }], [[]]])(
      'anything but { success: true } (%j) is unexpected_response',
      async (body) => {
        for (const call of [
          () => client.subscribePageApp(PAGE_ID, PAGE_TOKEN),
          () => client.unsubscribePageApp(PAGE_ID, PAGE_TOKEN),
        ]) {
          fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
          expect(await caught(call())).toMatchObject({
            kind: 'unexpected_response',
            status: 200,
          });
        }
      },
    );

    it.each([
      [190, 'token_invalid'],
      [4, 'rate_limited'],
      [200, 'permission'],
      [100, 'invalid_request'],
      [2, 'transient'],
    ] as const)(
      'Graph error #%i → %s, token and secret scrubbed',
      async (code, kind) => {
        for (const call of [
          () => client.subscribePageApp(PAGE_ID, PAGE_TOKEN),
          () => client.unsubscribePageApp(PAGE_ID, PAGE_TOKEN),
        ]) {
          fetchMock.mockResolvedValueOnce(
            graphError(400, {
              message: `bad ${PAGE_TOKEN} ${CONFIG.appSecret}`,
              code,
            }),
          );
          const error = await caught(call());
          expect(error).toMatchObject({ kind, code });
          expect(error.message).not.toContain(PAGE_TOKEN);
          expect(error.message).not.toContain(CONFIG.appSecret);
        }
      },
    );

    it('network failure → network error without the token', async () => {
      fetchMock.mockRejectedValue(new TypeError(`failed ${PAGE_TOKEN}`));
      const error = await caught(client.subscribePageApp(PAGE_ID, PAGE_TOKEN));
      expect(error).toMatchObject({ kind: 'network', retryable: true });
      expect(error.message).not.toContain(PAGE_TOKEN);
      expect(error.message).toContain('subscribed_apps');
    });

    it('rejects an empty token or a non-numeric Page id without calling fetch', async () => {
      await expect(client.subscribePageApp(PAGE_ID, '')).rejects.toThrow(
        'Token',
      );
      await expect(
        client.unsubscribePageApp('../me', PAGE_TOKEN),
      ).rejects.toThrow('Page id');
      await expect(
        new MetaGraphClient(null).subscribePageApp(PAGE_ID, PAGE_TOKEN),
      ).rejects.toBeInstanceOf(MetaNotConfiguredError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('revokePermissions (M4-T9)', () => {
    const proof = createHmac('sha256', CONFIG.appSecret)
      .update(USER_TOKEN)
      .digest('hex');
    const init = (n = 0) => fetchMock.mock.calls[n]![1]!;

    it('= DELETE /me/permissions with the user token + proof in the query', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));
      await expect(
        client.revokePermissions(USER_TOKEN),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = calledUrl();
      expect(url.origin + url.pathname).toBe(
        'https://graph.facebook.com/v26.0/me/permissions',
      );
      expect(init().method).toBe('DELETE');
      expect(init().body).toBeUndefined();
      expect(Object.fromEntries(url.searchParams)).toEqual({
        access_token: USER_TOKEN,
        appsecret_proof: proof,
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^DELETE \/me\/permissions 200 \d+ms$/),
      );
    });

    it.each([[{ success: false }], [{}], [{ success: 'true' }], [[]]])(
      'anything but { success: true } (%j) is unexpected_response',
      async (body) => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
        expect(
          await caught(client.revokePermissions(USER_TOKEN)),
        ).toMatchObject({ kind: 'unexpected_response', status: 200 });
      },
    );

    it.each([
      [190, 'token_invalid'],
      [4, 'rate_limited'],
      [200, 'permission'],
      [100, 'invalid_request'],
      [2, 'transient'],
    ] as const)(
      'Graph error #%i → %s, token and secret scrubbed',
      async (code, kind) => {
        fetchMock.mockResolvedValueOnce(
          graphError(400, {
            message: `bad ${USER_TOKEN} ${CONFIG.appSecret}`,
            code,
          }),
        );
        const error = await caught(client.revokePermissions(USER_TOKEN));
        expect(error).toMatchObject({ kind, code });
        expect(error.message).not.toContain(USER_TOKEN);
        expect(error.message).not.toContain(CONFIG.appSecret);
      },
    );

    it('network failure → network error without the token', async () => {
      fetchMock.mockRejectedValue(new TypeError(`failed ${USER_TOKEN}`));
      const error = await caught(client.revokePermissions(USER_TOKEN));
      expect(error).toMatchObject({ kind: 'network', retryable: true });
      expect(error.message).not.toContain(USER_TOKEN);
      expect(error.message).toContain('me/permissions');
    });

    it('rejects an empty token / disabled client without calling fetch', async () => {
      await expect(client.revokePermissions('')).rejects.toThrow('Token');
      await expect(
        new MetaGraphClient(null).revokePermissions(USER_TOKEN),
      ).rejects.toBeInstanceOf(MetaNotConfiguredError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('comment actions (M5-T9)', () => {
    const FB_COMMENT = '1010000000000001_2020000000000002';
    const IG_COMMENT = '17890000000000003';
    const proof = createHmac('sha256', CONFIG.appSecret)
      .update(PAGE_TOKEN)
      .digest('hex');
    const init = (n = 0) => fetchMock.mock.calls[n]![1]!;
    const formBody = (n = 0) => {
      const sent = init(n).body;
      expect(typeof sent).toBe('string');
      return Object.fromEntries(new URLSearchParams(sent as string));
    };
    const success = () => jsonResponse(200, { success: true });

    function expectPost(path: string, form: Record<string, string>) {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = calledUrl();
      expect(url.origin + url.pathname).toBe(
        `https://graph.facebook.com/v26.0/${path}`,
      );
      // Nothing in the URL: token, proof and fields travel in the form body.
      expect(url.search).toBe('');
      expect(init().method).toBe('POST');
      expect(init().headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(formBody()).toEqual({
        ...form,
        access_token: PAGE_TOKEN,
        appsecret_proof: proof,
      });
    }

    it.each([
      ['FACEBOOK', FB_COMMENT, 'is_hidden'],
      ['INSTAGRAM', IG_COMMENT, 'hide'],
    ] as const)(
      '%s hide = POST /{comment-id} form %s=true; unhide = %s=false',
      async (platform, id, field) => {
        fetchMock.mockResolvedValueOnce(success());
        await expect(
          client.hideComment(platform, id, PAGE_TOKEN),
        ).resolves.toBeUndefined();
        expectPost(id, { [field]: 'true' });
        expect(debugSpy).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`^POST /${id} 200 \\d+ms$`)),
        );

        fetchMock.mockReset().mockResolvedValueOnce(success());
        await expect(
          client.unhideComment(platform, id, PAGE_TOKEN),
        ).resolves.toBeUndefined();
        expectPost(id, { [field]: 'false' });
      },
    );

    it.each([FB_COMMENT, IG_COMMENT])(
      'delete = DELETE /%s with token + proof in the query, no body',
      async (id) => {
        fetchMock.mockResolvedValue(success());
        await expect(
          client.deleteComment(id, PAGE_TOKEN),
        ).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = calledUrl();
        expect(url.origin + url.pathname).toBe(
          `https://graph.facebook.com/v26.0/${id}`,
        );
        expect(init().method).toBe('DELETE');
        expect(init().body).toBeUndefined();
        expect(Object.fromEntries(url.searchParams)).toEqual({
          access_token: PAGE_TOKEN,
          appsecret_proof: proof,
        });
      },
    );

    it.each([
      ['FACEBOOK', FB_COMMENT, 'comments', '2020000000000002_3030000000000003'],
      ['INSTAGRAM', IG_COMMENT, 'replies', '17890000000000009'],
    ] as const)(
      '%s reply = POST /{comment-id}/%s form message → { id }',
      async (platform, id, edge, replyId) => {
        const message = 'ধন্যবাদ! Inbox e price pathachhi & 100% original';
        fetchMock.mockResolvedValue(jsonResponse(200, { id: replyId }));
        await expect(
          client.replyToComment(platform, id, message, PAGE_TOKEN),
        ).resolves.toEqual({ id: replyId });
        expectPost(`${id}/${edge}`, { message });
        expect(debugSpy).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`^POST /${id}/${edge} 200 \\d+ms$`)),
        );
        // The reply text never reaches the logs.
        for (const args of debugSpy.mock.calls) {
          expect(args.map(String).join(' ')).not.toContain('Inbox');
        }
      },
    );

    it.each([[{ success: false }], [{}], [{ success: 'true' }], [[]]])(
      'hide/unhide/delete: anything but { success: true } (%j) is unexpected_response',
      async (body) => {
        for (const call of [
          () => client.hideComment('FACEBOOK', FB_COMMENT, PAGE_TOKEN),
          () => client.unhideComment('INSTAGRAM', IG_COMMENT, PAGE_TOKEN),
          () => client.deleteComment(FB_COMMENT, PAGE_TOKEN),
        ]) {
          fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
          expect(await caught(call())).toMatchObject({
            kind: 'unexpected_response',
            status: 200,
            retryable: false,
          });
        }
      },
    );

    it.each([[{}], [{ id: 42 }], [{ id: 'abc' }], [{ success: true }], [[]]])(
      'reply: a body without a comment id (%j) is unexpected_response',
      async (body) => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
        expect(
          await caught(
            client.replyToComment('FACEBOOK', FB_COMMENT, 'hi', PAGE_TOKEN),
          ),
        ).toMatchObject({ kind: 'unexpected_response' });
      },
    );

    it.each([
      [100, 33, 'not_found', false],
      [100, undefined, 'invalid_request', false],
      [190, undefined, 'token_invalid', false],
      [4, undefined, 'rate_limited', true],
      [200, undefined, 'permission', false],
      [2, undefined, 'transient', true],
    ] as const)(
      'Graph error #%i/%s → %s (retryable %s) for every comment action',
      async (code, subcode, kind, retryable) => {
        for (const call of [
          () => client.hideComment('FACEBOOK', FB_COMMENT, PAGE_TOKEN),
          () => client.unhideComment('INSTAGRAM', IG_COMMENT, PAGE_TOKEN),
          () => client.deleteComment(IG_COMMENT, PAGE_TOKEN),
          () =>
            client.replyToComment('INSTAGRAM', IG_COMMENT, 'hi', PAGE_TOKEN),
        ]) {
          fetchMock.mockResolvedValueOnce(
            graphError(400, {
              message: `Object with ID '${FB_COMMENT}' does not exist ${PAGE_TOKEN}`,
              type: 'GraphMethodException',
              code,
              ...(subcode ? { error_subcode: subcode } : {}),
            }),
          );
          const error = await caught(call());
          expect(error).toMatchObject({ kind, code, retryable });
          expect(error.message).not.toContain(PAGE_TOKEN);
        }
      },
    );

    it('network failure → retryable network error without the token', async () => {
      fetchMock.mockRejectedValue(new TypeError(`failed ${PAGE_TOKEN}`));
      const error = await caught(
        client.hideComment('FACEBOOK', FB_COMMENT, PAGE_TOKEN),
      );
      expect(error).toMatchObject({ kind: 'network', retryable: true });
      expect(error.message).not.toContain(PAGE_TOKEN);
    });

    it('rejects a bad comment id, empty token, empty message or disabled client without calling fetch', async () => {
      await expect(
        client.hideComment('FACEBOOK', '../me', PAGE_TOKEN),
      ).rejects.toThrow('Comment id');
      await expect(client.deleteComment('1_2_3_4', PAGE_TOKEN)).rejects.toThrow(
        'Comment id',
      );
      await expect(
        client.unhideComment('INSTAGRAM', IG_COMMENT, ''),
      ).rejects.toThrow('Token');
      await expect(
        client.replyToComment('FACEBOOK', FB_COMMENT, '  ', PAGE_TOKEN),
      ).rejects.toThrow('message');
      await expect(
        new MetaGraphClient(null).deleteComment(FB_COMMENT, PAGE_TOKEN),
      ).rejects.toBeInstanceOf(MetaNotConfiguredError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getPostCaption (M5-T10)', () => {
    const FB_POST = '1010000000000001_2020000000000002';
    const IG_MEDIA = '17890000000000003';
    const proof = createHmac('sha256', CONFIG.appSecret)
      .update(PAGE_TOKEN)
      .digest('hex');
    const init = (n = 0) => fetchMock.mock.calls[n]![1]!;

    it.each([
      ['FACEBOOK', FB_POST, 'message'],
      ['INSTAGRAM', IG_MEDIA, 'caption'],
    ] as const)(
      '%s = GET /{id}?fields=%s with the Page token + proof in the query',
      async (platform, id, field) => {
        const text = 'ঈদ অফার! Panjabi 1,250 taka';
        fetchMock.mockResolvedValue(jsonResponse(200, { [field]: text, id }));
        await expect(
          client.getPostCaption(platform, id, PAGE_TOKEN),
        ).resolves.toBe(text);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = calledUrl();
        expect(url.origin + url.pathname).toBe(
          `https://graph.facebook.com/v26.0/${id}`,
        );
        expect(init().method).toBe('GET');
        expect(init().body).toBeUndefined();
        expect(Object.fromEntries(url.searchParams)).toEqual({
          fields: field,
          access_token: PAGE_TOKEN,
          appsecret_proof: proof,
        });
        expect(debugSpy).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`^GET /${id} 200 \\d+ms$`)),
        );
        // The caption never reaches the logs.
        for (const args of debugSpy.mock.calls) {
          expect(args.map(String).join(' ')).not.toContain('Panjabi');
        }
      },
    );

    it.each([
      [{ id: FB_POST }],
      [{ message: null }],
      [{ message: '' }],
      [{ message: '  \n ' }],
    ])('no text (%j) → null', async (body) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
      await expect(
        client.getPostCaption('FACEBOOK', FB_POST, PAGE_TOKEN),
      ).resolves.toBeNull();
    });

    it('reads only the platform field (an IG body with `message` has no caption)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { message: 'x' }));
      await expect(
        client.getPostCaption('INSTAGRAM', IG_MEDIA, PAGE_TOKEN),
      ).resolves.toBeNull();
    });

    it.each([
      [[]],
      ['caption'],
      [42],
      [{ message: 42 }],
      [{ message: { text: 'x' } }],
      [{ message: ['x'] }],
    ])('a bad body (%j) is unexpected_response', async (body) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
      expect(
        await caught(client.getPostCaption('FACEBOOK', FB_POST, PAGE_TOKEN)),
      ).toMatchObject({ kind: 'unexpected_response', retryable: false });
    });

    it.each([
      [100, 33, 'not_found', false],
      [190, undefined, 'token_invalid', false],
      [4, undefined, 'rate_limited', true],
      [10, undefined, 'permission', false],
      [2, undefined, 'transient', true],
    ] as const)(
      'Graph error #%i/%s → %s (retryable %s), token scrubbed',
      async (code, subcode, kind, retryable) => {
        fetchMock.mockResolvedValueOnce(
          graphError(400, {
            message: `Unsupported get request ${PAGE_TOKEN}`,
            type: 'GraphMethodException',
            code,
            ...(subcode ? { error_subcode: subcode } : {}),
          }),
        );
        const error = await caught(
          client.getPostCaption('INSTAGRAM', IG_MEDIA, PAGE_TOKEN),
        );
        expect(error).toMatchObject({ kind, code, retryable });
        expect(error.message).not.toContain(PAGE_TOKEN);
      },
    );

    it('rejects a bad post id, an empty token or a disabled client without calling fetch', async () => {
      for (const bad of ['../me', 'me', '1_2_3_4', '', '12?fields=x']) {
        await expect(
          client.getPostCaption('FACEBOOK', bad, PAGE_TOKEN),
        ).rejects.toThrow('Post id');
      }
      await expect(
        client.getPostCaption('FACEBOOK', FB_POST, ''),
      ).rejects.toThrow('Token');
      await expect(
        new MetaGraphClient(null).getPostCaption(
          'FACEBOOK',
          FB_POST,
          PAGE_TOKEN,
        ),
      ).rejects.toBeInstanceOf(MetaNotConfiguredError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('errors', () => {
    it.each([
      [190, 463, 'token_invalid', false],
      [190, undefined, 'token_invalid', false],
      [102, undefined, 'token_invalid', false],
      [4, undefined, 'rate_limited', true],
      [17, undefined, 'rate_limited', true],
      [32, undefined, 'rate_limited', true],
      [613, undefined, 'rate_limited', true],
      [80001, undefined, 'rate_limited', true],
      [10, undefined, 'permission', false],
      [200, undefined, 'permission', false],
      [299, undefined, 'permission', false],
      [100, undefined, 'invalid_request', false],
      [100, 33, 'not_found', false],
      [100, 34, 'invalid_request', false],
      [1, undefined, 'transient', true],
      [2, undefined, 'transient', true],
      [368, undefined, 'unknown', false],
    ] as const)(
      'Graph code %i/%s → %s (retryable %s)',
      async (code, subcode, kind, retryable) => {
        fetchMock.mockResolvedValue(
          graphError(400, {
            message: 'nope',
            type: 'OAuthException',
            code,
            ...(subcode ? { error_subcode: subcode } : {}),
          }),
        );
        const error = await caught(client.getMe(USER_TOKEN));
        expect(error).toMatchObject({ kind, code, retryable });
      },
    );

    it('is_transient marks an otherwise unknown code transient', async () => {
      fetchMock.mockResolvedValue(
        graphError(500, { message: 'x', code: 999, is_transient: true }),
      );
      expect(await caught(client.getMe(USER_TOKEN))).toMatchObject({
        kind: 'transient',
      });
    });

    it('a 5xx without a Graph error body is transient; a 4xx is unknown', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502 }));
      expect(await caught(client.getMe(USER_TOKEN))).toMatchObject({
        kind: 'transient',
        status: 502,
        code: undefined,
      });
      fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
      expect(await caught(client.getMe(USER_TOKEN))).toMatchObject({
        kind: 'unknown',
        status: 404,
      });
    });

    it('redacts the token and token-shaped strings from Meta messages', async () => {
      fetchMock.mockResolvedValue(
        graphError(400, {
          message: `Malformed access token ${USER_TOKEN} or EAAZotherTokenAbcdefghijklmnopqrstu`,
          code: 190,
        }),
      );
      const error = await caught(client.getMe(USER_TOKEN));
      expect(error.message).not.toContain(USER_TOKEN);
      expect(error.message).not.toContain('EAAZother');
      expect(error.message).toContain('[redacted]');
    });

    it('a 200 with a non-JSON body is unexpected_response', async () => {
      fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
      expect(await caught(client.getMe(USER_TOKEN))).toMatchObject({
        kind: 'unexpected_response',
      });
    });

    it('network failures become retryable network errors without the URL or cause', async () => {
      fetchMock.mockRejectedValue(
        new TypeError(`fetch failed for ?access_token=${USER_TOKEN}`),
      );
      const error = await caught(client.getMe(USER_TOKEN));
      expect(error).toMatchObject({
        kind: 'network',
        status: null,
        retryable: true,
      });
      expect(error.message).not.toContain(USER_TOKEN);
      expect(error.cause).toBeUndefined();
    });

    it('timeouts are network errors', async () => {
      fetchMock.mockRejectedValue(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      );
      const error = await caught(client.getMe(USER_TOKEN));
      expect(error).toMatchObject({ kind: 'network' });
      expect(error.message).toContain('timed out');
    });
  });
});

describe('createMetaAppConfig', () => {
  const fakeConfig = (values: Partial<EnvironmentVariables>) =>
    ({
      get: (key: keyof EnvironmentVariables) => values[key],
    }) as unknown as ConfigService<EnvironmentVariables, true>;
  const full = {
    META_APP_ID: '1',
    META_APP_SECRET: 's'.repeat(32),
    META_LOGIN_CONFIG_ID: '2',
    META_OAUTH_REDIRECT_URI: 'https://app.example.com/api/meta/oauth/callback',
  };

  it('is null when the app vars are unset', () => {
    expect(createMetaAppConfig(fakeConfig({}))).toBeNull();
  });

  it('defaults to the pinned version and honours META_GRAPH_API_VERSION', () => {
    expect(createMetaAppConfig(fakeConfig(full))).toEqual({
      appId: '1',
      appSecret: 's'.repeat(32),
      loginConfigId: '2',
      redirectUri: full.META_OAUTH_REDIRECT_URI,
      graphApiVersion: DEFAULT_GRAPH_API_VERSION,
    });
    expect(DEFAULT_GRAPH_API_VERSION).toBe('v26.0');
    expect(
      createMetaAppConfig(
        fakeConfig({ ...full, META_GRAPH_API_VERSION: 'v27.0' }),
      )?.graphApiVersion,
    ).toBe('v27.0');
  });

  it('META_GRAPH_BASE_URL (D17) is unset by default and loses a trailing slash', () => {
    expect(createMetaAppConfig(fakeConfig(full))?.graphBaseUrl).toBeUndefined();
    expect(
      createMetaAppConfig(
        fakeConfig({ ...full, META_GRAPH_BASE_URL: 'http://graph-stub:4010/' }),
      )?.graphBaseUrl,
    ).toBe('http://graph-stub:4010');
  });
});

describe('MetaGraphClient graph host', () => {
  const debug = vi
    .spyOn(Logger.prototype, 'debug')
    .mockImplementation(() => undefined);
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => debug.mockRestore());

  it.each([
    [undefined, 'https://graph.facebook.com/v26.0/me'],
    ['http://graph-stub:4010', 'http://graph-stub:4010/v26.0/me'],
  ])('base %s → %s', async (graphBaseUrl, expected) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { id: '1', name: 'x' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await new MetaGraphClient({ ...CONFIG, graphBaseUrl }).getMe(USER_TOKEN);
    const url = fetchMock.mock.calls[0]![0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe(expected);
  });
});
