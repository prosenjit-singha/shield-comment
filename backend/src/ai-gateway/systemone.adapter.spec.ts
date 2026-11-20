import { AiGatewayError } from './ai-gateway.errors.js';
import type { AiProviderConfig } from './ai-provider.js';
import {
  isSystemOneModel,
  parseSystemOneResponse,
  SystemOneAdapter,
  systemOneBaseUrl,
} from './systemone.adapter.js';

const KEY = 'nt_live_systemone_test_token_123';
const CONFIG: AiProviderConfig = {
  provider: 'neon',
  model: 'typesafeai-jev-1-14-0',
  apiKey: KEY,
  baseUrl: 'https://br-x-api.ai.aws.neon.tech',
};
const QUESTIONS = {
  scam: { type: 'noul' as const, instructions: 'Does `comment` offer money?' },
  abuse: {
    type: 'noul' as const,
    instructions: 'Does `comment` insult someone?',
    criteria: { true: 'Insults.', false: 'Polite words.' },
  },
};

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
  model: 'jev-1.14.0',
  answers: {
    scam: { type: 'noul', noul: 0.97 },
    abuse: { type: 'noul', noul: 0.02 },
  },
  usage: { input_tokens: 383, output_tokens: 61 },
};

describe('isSystemOneModel', () => {
  it.each([
    ['typesafeai-jev-1-14-0', true],
    ['openjev-qwen35-4b', true],
    ['gpt-oss-20b', false],
    ['claude-haiku-5-5', false],
    ['jev-latest', false],
  ])('%s → %s', (model, expected) => {
    expect(isSystemOneModel(model)).toBe(expected);
  });
});

describe('systemOneBaseUrl', () => {
  it.each([
    'https://br-x-api.ai.aws.neon.tech',
    'https://br-x-api.ai.aws.neon.tech//',
    'https://br-x-api.ai.aws.neon.tech/v1/',
  ])('%s', (base) => {
    expect(systemOneBaseUrl(base)).toBe(
      'https://br-x-api.ai.aws.neon.tech/typesafe',
    );
  });
});

describe('parseSystemOneResponse', () => {
  it('maps nouls, served model and usage', () => {
    expect(parseSystemOneResponse('m', ['scam', 'abuse'], OK)).toEqual({
      model: 'jev-1.14.0',
      nouls: { scam: 0.97, abuse: 0.02 },
      usage: { promptTokens: 383, completionTokens: 61, totalTokens: 444 },
    });
  });

  it('falls back to the requested model and omits missing usage', () => {
    expect(
      parseSystemOneResponse('typesafeai-jev-1-14-0', ['scam'], {
        answers: { scam: { type: 'noul', noul: 0 } },
      }),
    ).toEqual({ model: 'typesafeai-jev-1-14-0', nouls: { scam: 0 } });
  });

  it.each([
    ['not an object', 'oops'],
    ['no answers', { model: 'jev' }],
    ['missing answer', { answers: { scam: { noul: 0.4 } } }],
    ['non-numeric noul', { answers: { scam: { noul: '0.4' }, abuse: {} } }],
    [
      'noul out of range',
      { answers: { scam: { noul: 1.2 }, abuse: { noul: 0 } } },
    ],
  ])('%s → unexpected_response', (_, body) => {
    expect(() => parseSystemOneResponse('m', ['scam', 'abuse'], body)).toThrow(
      expect.objectContaining({ kind: 'unexpected_response' }) as Error,
    );
  });
});

describe('SystemOneAdapter', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    // Strict: any request without an armed answer fails the test.
    fetchMock.mockImplementation(async () => {
      throw new Error('Unexpected fetch in this spec');
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const decide = (config: AiProviderConfig = CONFIG) =>
    new SystemOneAdapter().decide(config, {
      model: 'typesafeai-jev-1-14-0',
      state: { comment: 'bkash e 500 taka cashback' },
      questions: QUESTIONS,
      timeoutMs: 15_000,
    });

  it('posts model + state + questions to /typesafe/v1/systemone via the SDK, once, uncompressed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, OK));
    await expect(decide()).resolves.toMatchObject({
      model: 'jev-1.14.0',
      nouls: { scam: 0.97, abuse: 0.02 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://br-x-api.ai.aws.neon.tech/typesafe/v1/systemone');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('content-encoding')).toBeNull();
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'typesafeai-jev-1-14-0',
      state: { comment: 'bkash e 500 taka cashback' },
      questions: QUESTIONS,
    });
  });

  it.each([
    [400, { message: 'missing or invalid model' }, 'invalid_request'],
    [401, { message: 'invalid token' }, 'auth'],
    [402, { message: 'no credits' }, 'payment_required'],
    [
      403,
      {
        message: 'AI credits needed',
        unavailable_reason: 'paid_plan_required',
      },
      'payment_required',
    ],
    [403, { message: 'missing ai_gateway:invoke scope' }, 'auth'],
    [429, { message: 'per-minute token limit' }, 'rate_limited'],
    [500, { message: 'upstream error' }, 'transient'],
    [503, { message: 'gateway busy' }, 'transient'],
  ] as const)('HTTP %i → %s', async (status, body, kind) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(status, { ...body, echoed: KEY }),
    );
    const error = await decide().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiGatewayError);
    expect(error).toMatchObject({ kind, status, provider: 'neon' });
    expect((error as Error).message).not.toContain(KEY);
    // SDK retries are off: one request even for 429 / 5xx (BullMQ owns retries).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a network failure → network', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(decide()).rejects.toMatchObject({ kind: 'network' });
  });

  it('the SDK timeout → timeout', async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason as Error),
          );
        }),
    );
    await expect(
      new SystemOneAdapter().decide(CONFIG, {
        model: 'typesafeai-jev-1-14-0',
        state: 'x',
        questions: QUESTIONS,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('refuses a non-Neon provider without a request', async () => {
    await expect(
      decide({ ...CONFIG, provider: 'openai' }),
    ).rejects.toMatchObject({ kind: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
