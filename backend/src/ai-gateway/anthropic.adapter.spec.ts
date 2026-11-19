import { Logger } from '@nestjs/common';
import { AiGatewayError } from './ai-gateway.errors.js';
import { AiGatewayService } from './ai-gateway.service.js';
import type { AiProviderConfig } from './ai-provider.js';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_JSON_OBJECT_INSTRUCTION,
  anthropicMessagesBody,
  anthropicMessagesUrl,
  parseAnthropicMessage,
} from './anthropic.adapter.js';

const KEY = 'sk-ant-api03-anthropicSECRETkey0123456789';
const CONFIG: AiProviderConfig = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  apiKey: KEY,
  baseUrl: 'https://api.anthropic.com/',
};
const URL = 'https://api.anthropic.com/v1/messages';

const OK = {
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5',
  content: [
    { type: 'text', text: '{"category":' },
    { type: 'text', text: '"SAFE_INQUIRY"}' },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 20, output_tokens: 7 },
};

const SCHEMA = {
  type: 'object',
  properties: { category: { type: 'string' } },
  required: ['category'],
  additionalProperties: false,
};

const MESSAGES = [
  { role: 'system' as const, content: 'You classify comments.' },
  { role: 'system' as const, content: 'Answer in JSON.' },
  { role: 'user' as const, content: 'bkash number din' },
];

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

const apiError = (type: string, message: string, extra = {}) => ({
  type: 'error',
  error: { type, message, ...extra },
  request_id: 'req_011',
});

function makeService(config: AiProviderConfig = CONFIG) {
  return new AiGatewayService({ resolve: async () => ({ ...config }) });
}

async function failure(promise: Promise<unknown>): Promise<AiGatewayError> {
  const e = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(e).toBeInstanceOf(AiGatewayError);
  return e as AiGatewayError;
}

describe('anthropic adapter helpers', () => {
  it.each([
    ['https://api.anthropic.com', URL],
    ['https://api.anthropic.com/', URL],
    ['https://api.anthropic.com///', URL],
    [' https://proxy.example/v1/ ', 'https://proxy.example/v1/messages'],
  ])('builds the messages URL from %j', (base, url) => {
    expect(anthropicMessagesUrl(base)).toBe(url);
  });

  it('moves system turns to the top-level system prompt', () => {
    expect(anthropicMessagesBody({ model: 'm', messages: MESSAGES })).toEqual({
      model: 'm',
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      system: 'You classify comments.\n\nAnswer in JSON.',
      messages: [{ role: 'user', content: 'bkash number din' }],
    });
  });

  it('keeps user/assistant order and omits system when there is none', () => {
    const body = anthropicMessagesBody({
      model: 'm',
      maxTokens: 64,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    expect(body).toEqual({
      model: 'm',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
  });

  it('never sends temperature (API version 2026-10-21 rejects it)', () => {
    const body = anthropicMessagesBody({
      model: 'm',
      temperature: 0,
      messages: [{ role: 'user', content: 'a' }],
    });
    expect(body).not.toHaveProperty('temperature');
  });

  it('maps json_schema to output_config.format (no name / strict)', () => {
    const body = anthropicMessagesBody({
      model: 'm',
      messages: [{ role: 'user', content: 'a' }],
      responseFormat: {
        type: 'json_schema',
        name: 'classification',
        schema: SCHEMA,
        strict: true,
      },
    });
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: SCHEMA },
    });
    expect(body).not.toHaveProperty('system');
  });

  it('maps json_object to a system instruction', () => {
    const body = anthropicMessagesBody({
      model: 'm',
      messages: MESSAGES,
      responseFormat: { type: 'json_object' },
    });
    expect(body.system).toBe(
      `You classify comments.\n\nAnswer in JSON.\n\n${ANTHROPIC_JSON_OBJECT_INSTRUCTION}`,
    );
    expect(body).not.toHaveProperty('output_config');
  });

  it.each([
    ['empty', []],
    ['system only', [{ role: 'system' as const, content: 's' }]],
    ['assistant first', [{ role: 'assistant' as const, content: 'a' }]],
  ])(
    'refuses a conversation that does not start with user (%s)',
    (_, messages) => {
      expect(() => anthropicMessagesBody({ model: 'm', messages })).toThrow(
        expect.objectContaining({ kind: 'invalid_request' }),
      );
    },
  );

  it('parses text blocks, usage (cache tokens included) and the stop reason', () => {
    expect(
      parseAnthropicMessage('req-model', {
        ...OK,
        content: [
          { type: 'thinking', thinking: '', signature: 'x' },
          ...OK.content,
        ],
        usage: {
          input_tokens: 20,
          output_tokens: 7,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 100,
        },
      }),
    ).toEqual({
      model: 'claude-haiku-4-5',
      content: '{"category":"SAFE_INQUIRY"}',
      usage: { promptTokens: 123, completionTokens: 7, totalTokens: 130 },
      finishReason: 'end_turn',
    });
  });

  it('falls back to the requested model and leaves usage out when missing', () => {
    expect(
      parseAnthropicMessage('req-model', {
        content: [{ type: 'text', text: 'ok' }],
      }),
    ).toEqual({
      model: 'req-model',
      content: 'ok',
      usage: undefined,
      finishReason: undefined,
    });
  });

  it.each([
    ['not an object', 'nope', undefined],
    ['no content', { model: 'm' }, undefined],
    ['empty content', { content: [] }, 'empty_content'],
    [
      'blank text',
      { content: [{ type: 'text', text: '  ' }] },
      'empty_content',
    ],
    [
      'only thinking (max_tokens)',
      {
        content: [{ type: 'thinking', thinking: '' }],
        stop_reason: 'max_tokens',
      },
      'empty_content',
    ],
  ])('turns %s into unexpected_response', (_, body, reason) => {
    try {
      parseAnthropicMessage('m', body);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        kind: 'unexpected_response',
        provider: 'anthropic',
        status: 200,
        reason,
      });
    }
  });
});

describe('AnthropicAdapter via AiGatewayService', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const logs: string[] = [];
  beforeEach(() => {
    fetchMock.mockReset();
    // Strict: any request without an armed answer fails the test.
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

  it('posts to /v1/messages with x-api-key + anthropic-version and maps the result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, OK));
    const res = await makeService().chat(MESSAGES, {
      maxTokens: 256,
      temperature: 0,
      responseFormat: { type: 'json_schema', name: 'c', schema: SCHEMA },
    });
    expect(res).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      content: '{"category":"SAFE_INQUIRY"}',
      usage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 },
      finishReason: 'end_turn',
      latencyMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBe(KEY);
    expect(headers.get('anthropic-version')).toBe(ANTHROPIC_API_VERSION);
    expect(ANTHROPIC_API_VERSION).toBe('2026-10-21');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('anthropic-beta')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      system: 'You classify comments.\n\nAnswer in JSON.',
      messages: [{ role: 'user', content: 'bkash number din' }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
  });

  it('uses the default max_tokens and a per-call model', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] }),
    );
    const res = await makeService().chat([{ role: 'user', content: 'hi' }], {
      model: 'claude-sonnet-5-5',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res).toMatchObject({ model: 'claude-sonnet-5-5', content: 'ok' });
  });

  it('refuses an assistant-first conversation without a fetch', async () => {
    const e = await failure(
      makeService().chat([{ role: 'assistant', content: 'x' }]),
    );
    expect(e).toMatchObject({ kind: 'invalid_request', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns an empty reply into unexpected_response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { content: [], stop_reason: 'end_turn' }),
    );
    const e = await failure(makeService().chat(MESSAGES));
    expect(e).toMatchObject({ kind: 'unexpected_response', retryable: false });
  });

  describe('error mapping', () => {
    const NOW = Date.parse('2026-11-19T10:00:00Z');
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it.each([
      [
        '401 authentication_error',
        401,
        apiError('authentication_error', 'invalid x-api-key'),
        {},
        'auth',
        false,
        undefined,
      ],
      [
        '403 permission_error',
        403,
        apiError('permission_error', 'Not allowed'),
        {},
        'auth',
        false,
        undefined,
      ],
      [
        '404 unknown model',
        404,
        apiError('not_found_error', 'model: claude-nope'),
        {},
        'invalid_request',
        false,
        undefined,
      ],
      [
        '400 invalid_request_error',
        400,
        apiError('invalid_request_error', 'max_tokens: must be positive'),
        {},
        'invalid_request',
        false,
        undefined,
      ],
      [
        '400 credit balance too low',
        400,
        apiError(
          'invalid_request_error',
          'Your credit balance is too low to access the Anthropic API.',
        ),
        {},
        'payment_required',
        false,
        undefined,
      ],
      [
        '402 billing_error',
        402,
        apiError('billing_error', 'Billing problem'),
        {},
        'payment_required',
        false,
        undefined,
      ],
      [
        '413 request_too_large',
        413,
        apiError('request_too_large', 'Request exceeds the maximum size'),
        {},
        'invalid_request',
        false,
        undefined,
      ],
      [
        '429 with retry-after seconds',
        429,
        apiError('rate_limit_error', 'Number of request tokens exceeded'),
        { 'retry-after': '7' },
        'rate_limited',
        true,
        7000,
      ],
      [
        '429 without retry-after',
        429,
        apiError('rate_limit_error', 'slow down'),
        {},
        'rate_limited',
        true,
        undefined,
      ],
      [
        '429 monthly spend cap',
        429,
        apiError('rate_limit_error', 'spend limit reached', {
          details: { error_code: 'enforced_spend_limit_reached' },
        }),
        {},
        'payment_required',
        false,
        undefined,
      ],
      [
        '500 api_error',
        500,
        apiError('api_error', 'Internal server error'),
        {},
        'transient',
        true,
        undefined,
      ],
      [
        '529 overloaded_error',
        529,
        apiError('overloaded_error', 'Overloaded'),
        { 'retry-after': '2' },
        'transient',
        true,
        2000,
      ],
    ])(
      '%s → %s',
      async (_, status, body, headers, kind, retryable, retryAfterMs) => {
        fetchMock.mockResolvedValueOnce(jsonResponse(status, body, headers));
        const e = await failure(makeService().chat(MESSAGES));
        expect(e).toMatchObject({
          kind,
          retryable,
          status,
          provider: 'anthropic',
        });
        expect(e.retryAfterMs).toBe(retryAfterMs);
        expect(e.message).toMatch(new RegExp(`^AI anthropic ${status}`));
        expect(e.param).toBeUndefined();
      },
    );

    it('keeps the reason from the Anthropic error type', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(529, apiError('overloaded_error', 'Overloaded')),
      );
      const e = await failure(makeService().chat(MESSAGES));
      expect(e.reason).toBe('overloaded_error');
      expect(e.message).toBe('AI anthropic 529 (overloaded_error): Overloaded');
    });

    it('marks a refused output schema as param response_format', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          400,
          apiError(
            'invalid_request_error',
            'output_config.format.schema: minLength is not supported',
          ),
        ),
      );
      const e = await failure(
        makeService().chat(MESSAGES, {
          responseFormat: { type: 'json_schema', name: 'c', schema: SCHEMA },
        }),
      );
      expect(e).toMatchObject({
        kind: 'invalid_request',
        param: 'response_format',
        status: 400,
        reason: 'invalid_request_error',
        provider: 'anthropic',
        retryable: false,
      });
    });

    it('does not mark other 400s (or calls without a schema) as a schema refusal', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, apiError('invalid_request_error', 'messages: empty')),
      );
      const withSchema = await failure(
        makeService().chat(MESSAGES, {
          responseFormat: { type: 'json_schema', name: 'c', schema: SCHEMA },
        }),
      );
      expect(withSchema.param).toBeUndefined();
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, apiError('invalid_request_error', 'bad schema')),
      );
      const noSchema = await failure(makeService().chat(MESSAGES));
      expect(noSchema.param).toBeUndefined();
    });

    it('maps a non-JSON 502 by status', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('<html>Bad Gateway</html>', { status: 502 }),
      );
      const e = await failure(makeService().chat(MESSAGES));
      expect(e).toMatchObject({
        kind: 'transient',
        status: 502,
        retryable: true,
      });
      expect(e.message).toBe('AI anthropic 502: HTTP 502');
    });
  });

  it('times out → timeout', async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const e = await failure(makeService().chat(MESSAGES, { timeoutMs: 5 }));
    expect(e).toMatchObject({ kind: 'timeout', retryable: true, status: null });
    expect(e.message).toBe('AI anthropic request timed out');
  });

  it('fetch failure → network, without the URL, key or cause', async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError(`fetch failed: ${URL} x-api-key ${KEY}`),
    );
    const e = await failure(makeService().chat(MESSAGES));
    expect(e).toMatchObject({ kind: 'network', retryable: true });
    expect(e.message).toBe('AI anthropic request failed (network)');
    expect(e.message).not.toContain(URL);
    expect(e.cause).toBeUndefined();
  });

  it('never puts the key in an error or a log, and logs no prompt or reply', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        401,
        apiError('authentication_error', `invalid x-api-key ${KEY}`),
      ),
    );
    const secretPrompt = 'SECRET-PROMPT bkash 01711111111';
    const e = await failure(
      makeService().chat([{ role: 'user', content: secretPrompt }]),
    );
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain('[redacted]');
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { content: [{ type: 'text', text: 'SECRET-REPLY' }] }),
    );
    await makeService().chat([{ role: 'user', content: secretPrompt }]);
    const joined = logs.join('\n');
    expect(joined).toMatch(/provider=anthropic/);
    expect(joined).toMatch(/kind=auth/);
    expect(joined).not.toContain('SECRET-PROMPT');
    expect(joined).not.toContain('SECRET-REPLY');
    expect(joined).not.toContain(KEY);
  });
});
