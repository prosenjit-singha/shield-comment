import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  AiGatewayError,
  AiGatewayNotConfiguredError,
  AiGatewayService,
  DEFAULT_AI_GATEWAY_MODEL,
  extractText,
} from './ai-gateway.service.js';

function makeService(values: Partial<EnvironmentVariables>): AiGatewayService {
  const config = {
    get: (key: keyof EnvironmentVariables) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return new AiGatewayService(config);
}

const configured = {
  NEON_AI_GATEWAY_BASE_URL: 'https://br-x-api.ai.c-1.us-east-2.aws.neon.tech/',
  NEON_AI_GATEWAY_TOKEN: 'nt_live_test',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AiGatewayService', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the unified chat completions route with the bearer token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: 'gpt-oss-20b',
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
    );
    const res = await makeService(configured).chat(
      [{ role: 'user', content: 'ping' }],
      { maxTokens: 16 },
    );
    expect(res).toEqual({
      model: 'gpt-oss-20b',
      content: 'pong',
      usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://br-x-api.ai.c-1.us-east-2.aws.neon.tech/v1/chat/completions',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer nt_live_test',
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      model: DEFAULT_AI_GATEWAY_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
    });
  });

  it('uses AI_GATEWAY_MODEL and lets callers override the model', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const svc = makeService({
      ...configured,
      AI_GATEWAY_MODEL: 'claude-haiku-4-5',
    });
    await svc.chat([{ role: 'user', content: 'a' }]);
    await svc.chat([{ role: 'user', content: 'b' }], { model: 'gpt-5-nano' });
    const models = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init?.body as string).model,
    );
    expect(models).toEqual(['claude-haiku-4-5', 'gpt-5-nano']);
  });

  it('maps gateway errors, including the unavailable reason', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: {
          message: 'Model not enabled',
          unavailable_reason: 'paid_plan_required',
        },
      }),
    );
    const err = await makeService(configured)
      .chat([{ role: 'user', content: 'x' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiGatewayError);
    expect(err).toMatchObject({ status: 403, reason: 'paid_plan_required' });
    expect((err as Error).message).toContain('Model not enabled');
  });

  it('throws when not configured, without calling fetch', async () => {
    const svc = makeService({});
    expect(svc.enabled).toBe(false);
    await expect(
      svc.chat([{ role: 'user', content: 'x' }]),
    ).rejects.toBeInstanceOf(AiGatewayNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('extractText', () => {
  it('handles string and multi-part content', () => {
    expect(extractText('hi')).toBe('hi');
    expect(
      extractText([
        { type: 'reasoning', summary: [] },
        { type: 'text', text: 'po' },
        { type: 'text', text: 'ng' },
      ]),
    ).toBe('pong');
    expect(extractText(null)).toBe('');
  });
});
