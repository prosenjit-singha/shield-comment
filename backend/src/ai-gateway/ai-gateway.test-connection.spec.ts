import { Logger } from '@nestjs/common';
import {
  AiGatewayService,
  CONNECTION_TEST_MAX_TOKENS,
  CONNECTION_TEST_MESSAGES,
  CONNECTION_TEST_QUESTIONS,
  CONNECTION_TEST_STATE,
  CONNECTION_TEST_TIMEOUT_MS,
} from './ai-gateway.service.js';
import type { AiConfigResolver, AiProviderConfig } from './ai-provider.js';

const KEYS = {
  neon: 'nt_live_neonSECRETtoken',
  openai: 'sk-proj-openaiSECRETkey0123456789',
  google: 'AIzaSyGoogleSECRETkey0123456789abc',
  anthropic: 'sk-ant-api03-anthropicSECRETkey0123',
};

const CONFIGS: Record<keyof typeof KEYS, AiProviderConfig> = {
  neon: {
    provider: 'neon',
    model: 'gpt-oss-20b',
    apiKey: KEYS.neon,
    baseUrl: 'https://br-x-api.ai.c-1.aws.neon.tech',
  },
  openai: {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: KEYS.openai,
    baseUrl: 'https://api.openai.com/v1',
  },
  google: {
    provider: 'google',
    model: 'gemini-2.5-flash-lite',
    apiKey: KEYS.google,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  anthropic: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    apiKey: KEYS.anthropic,
    baseUrl: 'https://api.anthropic.com',
  },
};

const PROVIDERS = ['neon', 'openai', 'google', 'anthropic'] as const;

const URLS = {
  neon: 'https://br-x-api.ai.c-1.aws.neon.tech/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  google:
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

const okBody = (provider: keyof typeof KEYS) =>
  provider === 'anthropic'
    ? { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }
    : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] };

const emptyBody = (provider: keyof typeof KEYS) =>
  provider === 'anthropic'
    ? { content: [], stop_reason: 'max_tokens' }
    : { choices: [{ message: { content: '' }, finish_reason: 'length' }] };

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeService(config: AiProviderConfig | null) {
  const resolve = vi.fn<AiConfigResolver['resolve']>(async () =>
    config ? { ...config } : null,
  );
  return { svc: new AiGatewayService({ resolve }), resolve };
}

describe('AiGatewayService.testConnection', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const logs: string[] = [];
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => {
      throw new Error('Unexpected fetch in this spec');
    });
    vi.stubGlobal('fetch', fetchMock);
    logs.length = 0;
    for (const level of ['log', 'debug', 'warn', 'error', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (message: unknown) => {
          logs.push(String(message));
        },
      );
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses a fixed tiny probe: 16 tokens, 10 s', () => {
    expect(CONNECTION_TEST_MAX_TOKENS).toBeLessThanOrEqual(16);
    expect(CONNECTION_TEST_TIMEOUT_MS).toBe(10_000);
    expect(CONNECTION_TEST_MESSAGES).toEqual([
      { role: 'user', content: 'Reply with the single word OK.' },
    ]);
  });

  describe.each(PROVIDERS)('%s', (provider) => {
    it('answers ok with latency, provider and model', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, okBody(provider)));
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const result = await makeService(CONFIGS[provider]).svc.testConnection();
      expect(result).toEqual({
        ok: true,
        provider,
        model: CONFIGS[provider].model,
        latencyMs: expect.any(Number),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(URLS[provider]);
      const body = JSON.parse(init?.body as string);
      expect(body.max_tokens ?? body.max_completion_tokens).toBe(
        CONNECTION_TEST_MAX_TOKENS,
      );
      expect(body.messages).toEqual(CONNECTION_TEST_MESSAGES);
      expect(body).not.toHaveProperty('response_format');
      expect(body).not.toHaveProperty('output_config');
      expect(timeout).toHaveBeenCalledWith(CONNECTION_TEST_TIMEOUT_MS);
    });

    it('counts a 2xx with an empty (cut-off) reply as reachable', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, emptyBody(provider)));
      await expect(
        makeService(CONFIGS[provider]).svc.testConnection(),
      ).resolves.toMatchObject({ ok: true, provider });
    });

    it('reports a provider failure as a kind, scrubbed, without throwing', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, {
          error: { message: `bad key ${KEYS[provider]}`, type: 'auth' },
        }),
      );
      const result = await makeService(CONFIGS[provider]).svc.testConnection();
      expect(result).toEqual({
        ok: false,
        kind: 'auth',
        latencyMs: expect.any(Number),
        provider,
        model: CONFIGS[provider].model,
        message: expect.stringContaining('[redacted]'),
      });
      expect(JSON.stringify(result)).not.toContain(KEYS[provider]);
    });
  });

  it.each([
    ['payment_required', 402, {}, {}],
    [
      'payment_required',
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'Your credit balance is too low to access the Anthropic API.',
        },
      },
      {},
    ],
    ['auth', 403, { error: { type: 'permission_error', message: 'no' } }, {}],
    [
      'rate_limited',
      429,
      { error: { message: 'slow' } },
      { 'retry-after': '3' },
    ],
    ['transient', 529, { error: { type: 'overloaded_error' } }, {}],
    ['invalid_request', 404, { error: { type: 'not_found_error' } }, {}],
  ])('maps %s (HTTP %i) for anthropic', async (kind, status, body, headers) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, body, headers));
    await expect(
      makeService(CONFIGS.anthropic).svc.testConnection(),
    ).resolves.toMatchObject({ ok: false, kind, provider: 'anthropic' });
  });

  it('maps a non-JSON 200 to unexpected_response (not reachable)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>captive portal</html>', { status: 200 }),
    );
    await expect(
      makeService(CONFIGS.neon).svc.testConnection(),
    ).resolves.toMatchObject({ ok: false, kind: 'unexpected_response' });
  });

  it('maps a timeout', async () => {
    const abort = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
    fetchMock.mockImplementationOnce((_url, init) => {
      // The probe's 10 s timer fires while the provider hangs.
      abort.abort(new DOMException('timed out', 'TimeoutError'));
      return Promise.reject(init?.signal?.reason as Error);
    });
    const pending = makeService(CONFIGS.openai).svc.testConnection();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      kind: 'timeout',
      provider: 'openai',
    });
  });

  it('maps a network failure without the URL or key', async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError(`fetch failed ${URLS.google} ${KEYS.google}`),
    );
    const result = await makeService(CONFIGS.google).svc.testConnection();
    expect(result).toMatchObject({
      ok: false,
      kind: 'network',
      message: 'AI google request failed (network)',
    });
    expect(JSON.stringify(result)).not.toContain(KEYS.google);
  });

  it('is not_configured without a config, and never fetches', async () => {
    await expect(makeService(null).svc.testConnection()).resolves.toEqual({
      ok: false,
      kind: 'not_configured',
      latencyMs: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tests an explicit (draft) config instead of the saved one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, okBody('anthropic')));
    const { svc, resolve } = makeService(CONFIGS.neon);
    await expect(
      svc.testConnection({ ...CONFIGS.anthropic, model: 'claude-sonnet-5-5' }),
    ).resolves.toMatchObject({
      ok: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe(URLS.anthropic);
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe(
      'claude-sonnet-5-5',
    );
  });

  describe('System One model (jev)', () => {
    const JEV = { ...CONFIGS.neon, model: 'typesafeai-jev-1-14-0' };

    it('sends one tiny Noul to /typesafe/v1/systemone, no chat call', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          model: 'jev-1.14.0',
          answers: { ok: { noul: 0.99 } },
          usage: { input_tokens: 40, output_tokens: 0 },
        }),
      );
      await expect(makeService(JEV).svc.testConnection()).resolves.toEqual({
        ok: true,
        provider: 'neon',
        model: 'typesafeai-jev-1-14-0',
        latencyMs: expect.any(Number),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://br-x-api.ai.c-1.aws.neon.tech/typesafe/v1/systemone',
      );
      expect(JSON.parse(init?.body as string)).toMatchObject({
        model: 'typesafeai-jev-1-14-0',
        state: CONNECTION_TEST_STATE,
        questions: CONNECTION_TEST_QUESTIONS,
      });
      expect(Object.keys(CONNECTION_TEST_QUESTIONS)).toHaveLength(1);
    });

    it('maps a failure to its kind, key scrubbed', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(402, { message: `no credits for ${KEYS.neon}` }),
      );
      const result = await makeService(JEV).svc.testConnection();
      expect(result).toMatchObject({
        ok: false,
        kind: 'payment_required',
        provider: 'neon',
        model: 'typesafeai-jev-1-14-0',
      });
      expect(JSON.stringify(result)).not.toContain(KEYS.neon);
    });
  });

  it('logs kind and ms only', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { message: `bad ${KEYS.anthropic}` } }),
    );
    await makeService(CONFIGS.anthropic).svc.testConnection();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, okBody('neon')));
    await makeService(CONFIGS.neon).svc.testConnection();
    await makeService(null).svc.testConnection();
    expect(logs).toEqual([
      expect.stringMatching(/^connection test failed kind=auth ms=\d+$/),
      expect.stringMatching(/^connection test ok ms=\d+$/),
      'connection test failed kind=not_configured ms=0',
    ]);
  });
});
