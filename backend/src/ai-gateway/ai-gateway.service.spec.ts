import { Logger } from '@nestjs/common';
import {
  AiGatewayError,
  AiGatewayNotConfiguredError,
} from './ai-gateway.errors.js';
import {
  AiGatewayService,
  MODERATION_TIMEOUT_MS,
} from './ai-gateway.service.js';
import type { AiConfigResolver, AiProviderConfig } from './ai-provider.js';

const KEYS = {
  neon: 'nt_live_neonSECRETtoken',
  openai: 'sk-proj-openaiSECRETkey0123456789',
  google: 'AIzaSyGoogleSECRETkey0123456789abc',
  anthropic: 'sk-ant-api03-anthropicSECRETkey',
};

const CONFIGS: Record<keyof typeof KEYS, AiProviderConfig> = {
  neon: {
    provider: 'neon',
    model: 'gpt-oss-20b',
    apiKey: KEYS.neon,
    baseUrl: 'https://br-x-api.ai.c-1.aws.neon.tech/',
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

const URLS = {
  neon: 'https://br-x-api.ai.c-1.aws.neon.tech/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  google:
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};

function makeService(config: AiProviderConfig | null) {
  const resolve = vi.fn<AiConfigResolver['resolve']>(async () =>
    config ? { ...config } : null,
  );
  return { svc: new AiGatewayService({ resolve }), resolve };
}

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

const OK = {
  model: 'gpt-oss-20b',
  choices: [
    { message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

const MESSAGES = [{ role: 'user' as const, content: 'ping' }];

async function failure(promise: Promise<unknown>): Promise<AiGatewayError> {
  const e = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(e).toBeInstanceOf(AiGatewayError);
  return e as AiGatewayError;
}

describe('AiGatewayService', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const logs: string[] = [];
  beforeEach(() => {
    fetchMock.mockReset();
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

  describe.each(['neon', 'openai', 'google'] as const)(
    '%s (OpenAI-compatible)',
    (provider) => {
      it('posts to its chat completions URL with the Bearer key and maps the result', async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, OK));
        const { svc } = makeService(CONFIGS[provider]);
        const res = await svc.chat(MESSAGES, {
          maxTokens: 16,
          temperature: 0,
          responseFormat: { type: 'json_object' },
        });
        expect(res).toEqual({
          provider,
          model: 'gpt-oss-20b',
          content: 'pong',
          usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
          finishReason: 'stop',
          latencyMs: expect.any(Number),
        });
        expect(res.latencyMs).toBeGreaterThanOrEqual(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(URLS[provider]);
        expect(init?.method).toBe('POST');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(`Bearer ${KEYS[provider]}`);
        expect(headers.get('content-type')).toBe('application/json');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(init?.body as string)).toEqual({
          model: CONFIGS[provider].model,
          messages: MESSAGES,
          [provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: 16,
          temperature: 0,
          response_format: { type: 'json_object' },
        });
      });
    },
  );

  it('lets a call override the model', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const { svc } = makeService(CONFIGS.neon);
    const res = await svc.chat(MESSAGES, { model: 'gpt-5-nano' });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe(
      'gpt-5-nano',
    );
    expect(res.model).toBe('gpt-5-nano');
    expect(res.usage).toBeUndefined();
  });

  it('uses an explicit config instead of the resolver', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, OK));
    const { svc, resolve } = makeService(CONFIGS.neon);
    const res = await svc.chat(MESSAGES, { config: CONFIGS.google });
    expect(resolve).not.toHaveBeenCalled();
    expect(res.provider).toBe('google');
    expect(fetchMock.mock.calls[0][0]).toBe(URLS.google);
  });

  it('works with an unconfigured resolver when a config is passed', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, OK));
    const { svc } = makeService(null);
    await expect(
      svc.chat(MESSAGES, { config: CONFIGS.openai }),
    ).resolves.toMatchObject({
      provider: 'openai',
    });
  });

  it('is not configured without a config, and never fetches', async () => {
    const { svc } = makeService(null);
    await expect(svc.isConfigured()).resolves.toBe(false);
    const e = await failure(svc.chat(MESSAGES));
    expect(e).toBeInstanceOf(AiGatewayNotConfiguredError);
    expect(e).toMatchObject({ kind: 'not_configured', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports every provider as configured once it has a config (anthropic since M5-T2)', async () => {
    for (const provider of ['neon', 'openai', 'google', 'anthropic'] as const) {
      await expect(
        makeService(CONFIGS[provider]).svc.isConfigured(),
      ).resolves.toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns empty content into unexpected_response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: '' } }] }),
    );
    const e = await failure(makeService(CONFIGS.neon).svc.chat(MESSAGES));
    expect(e).toMatchObject({
      kind: 'unexpected_response',
      retryable: false,
      reason: 'empty_content',
    });
  });

  it('turns a non-JSON 200 body into unexpected_response', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>ok</html>', { status: 200 }),
    );
    const e = await failure(makeService(CONFIGS.neon).svc.chat(MESSAGES));
    expect(e).toMatchObject({ kind: 'unexpected_response', status: 200 });
  });

  describe('error mapping', () => {
    const NOW = Date.parse('2026-11-19T10:00:00Z');
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it.each([
      ['402', 402, {}, {}, 'payment_required', false, undefined],
      [
        '401',
        401,
        { error: { message: 'Incorrect API key' } },
        {},
        'auth',
        false,
        undefined,
      ],
      [
        '403 paid_plan_required',
        403,
        {
          error: {
            message: 'Model not enabled',
            unavailable_reason: 'paid_plan_required',
          },
        },
        {},
        'payment_required',
        false,
        undefined,
      ],
      [
        '403 other',
        403,
        { error: { message: 'Forbidden' } },
        {},
        'auth',
        false,
        undefined,
      ],
      [
        '429 insufficient_quota',
        429,
        {
          error: {
            type: 'insufficient_quota',
            code: 'insufficient_quota',
            message: 'quota',
          },
        },
        { 'Retry-After': '20' },
        'payment_required',
        false,
        undefined,
      ],
      [
        '400 response_format refused',
        400,
        {
          error: {
            message:
              "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
            type: 'invalid_request_error',
            param: 'response_format',
          },
        },
        {},
        'invalid_request',
        false,
        undefined,
      ],
      [
        '404 unknown model',
        404,
        { error: { code: 'model_not_found' } },
        {},
        'invalid_request',
        false,
        undefined,
      ],
      ['408', 408, {}, {}, 'transient', true, undefined],
      [
        '422',
        422,
        { message: 'unprocessable' },
        {},
        'invalid_request',
        false,
        undefined,
      ],
      [
        '429 Retry-After seconds',
        429,
        {},
        { 'Retry-After': '12' },
        'rate_limited',
        true,
        12_000,
      ],
      [
        '429 Retry-After date',
        429,
        {},
        { 'Retry-After': 'Thu, 19 Nov 2026 10:00:30 GMT' },
        'rate_limited',
        true,
        30_000,
      ],
      ['429 no Retry-After', 429, {}, {}, 'rate_limited', true, undefined],
      [
        '500',
        500,
        { error: { message: 'boom' } },
        {},
        'transient',
        true,
        undefined,
      ],
      [
        '503 Retry-After',
        503,
        {},
        { 'Retry-After': '2' },
        'transient',
        true,
        2000,
      ],
    ] as const)(
      '%s → %s',
      async (_label, status, body, headers, kind, retryable, retryAfterMs) => {
        fetchMock.mockResolvedValue(jsonResponse(status, body, headers));
        const e = await failure(makeService(CONFIGS.openai).svc.chat(MESSAGES));
        expect(e).toMatchObject({
          kind,
          retryable,
          status,
          provider: 'openai',
        });
        expect(e.retryAfterMs).toBe(retryAfterMs);
        expect(e.message).toMatch(new RegExp(`^AI openai ${status}`));
      },
    );

    it('keeps the response_format refusal distinguishable', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, {
          error: { message: 'unsupported', param: 'response_format' },
        }),
      );
      const e = await failure(makeService(CONFIGS.openai).svc.chat(MESSAGES));
      expect(e).toMatchObject({
        kind: 'invalid_request',
        param: 'response_format',
      });
    });

    it('maps a non-JSON error body by status', async () => {
      fetchMock.mockResolvedValue(
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          statusText: 'Bad Gateway',
        }),
      );
      const e = await failure(makeService(CONFIGS.neon).svc.chat(MESSAGES));
      expect(e).toMatchObject({
        kind: 'transient',
        status: 502,
        retryable: true,
      });
      expect(e.message).toBe('AI neon 502: HTTP 502');
    });
  });

  it('times out → timeout, retryable', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const e = await failure(
      makeService(CONFIGS.neon).svc.chat(MESSAGES, { timeoutMs: 5 }),
    );
    expect(e).toMatchObject({ kind: 'timeout', retryable: true, status: null });
  });

  it('exports a 15 s moderation timeout', () => {
    expect(MODERATION_TIMEOUT_MS).toBe(15_000);
  });

  it('fetch failure → network, without the URL, key or cause', async () => {
    fetchMock.mockRejectedValue(
      new TypeError(`fetch failed: ${URLS.openai} Bearer ${KEYS.openai}`),
    );
    const e = await failure(makeService(CONFIGS.openai).svc.chat(MESSAGES));
    expect(e).toMatchObject({ kind: 'network', retryable: true, status: null });
    expect(e.message).toBe('AI openai request failed (network)');
    expect(e.cause).toBeUndefined();
  });

  it('never puts the key in an error message, and logs no prompt or reply', async () => {
    const secretPrompt = 'SECRET-PROMPT bkash 01711111111';
    for (const provider of ['neon', 'openai', 'google'] as const) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, {
          error: {
            message: `Incorrect API key provided: ${KEYS[provider]}`,
            code: KEYS[provider],
          },
        }),
      );
      const e = await failure(
        makeService(CONFIGS[provider]).svc.chat([
          { role: 'user', content: secretPrompt },
        ]),
      );
      expect(e.message).not.toContain(KEYS[provider]);
      expect(e.reason ?? '').not.toContain(KEYS[provider]);
      expect(e.message).toContain('[redacted]');
    }
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [{ message: { content: 'SECRET-REPLY' } }],
      }),
    );
    await makeService(CONFIGS.neon).svc.chat([
      { role: 'user', content: secretPrompt },
    ]);
    expect(logs.length).toBeGreaterThan(0);
    const joined = logs.join('\n');
    expect(joined).not.toContain('SECRET-PROMPT');
    expect(joined).not.toContain('SECRET-REPLY');
    for (const key of Object.values(KEYS)) expect(joined).not.toContain(key);
    expect(joined).toMatch(/kind=auth/);
  });
});
