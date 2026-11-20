import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  createTelegramConfig,
  TELEGRAM_SEND_TIMEOUT_MS,
  TelegramClient,
  type TelegramConfig,
  telegramErrorKind,
  TelegramSendError,
} from './telegram.client.js';

const TOKEN = '123456789:unit-test-token-abcdefghijklmnopqrst';
const CONFIG: TelegramConfig = {
  botToken: TOKEN,
  botUsername: 'ShieldTestBot',
  webhookSecret: 'unit-webhook-secret-0123',
  apiBaseUrl: 'http://stub.test',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function configOf(env: Partial<EnvironmentVariables>) {
  return {
    get: (key: keyof EnvironmentVariables) => env[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
}

describe('createTelegramConfig', () => {
  it('null when unset; real API by default; strips a trailing slash from the stub URL', () => {
    expect(createTelegramConfig(configOf({}))).toBeNull();
    const env = {
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_BOT_USERNAME: 'ShieldTestBot',
      TELEGRAM_WEBHOOK_SECRET: 'unit-webhook-secret-0123',
    };
    expect(createTelegramConfig(configOf(env))?.apiBaseUrl).toBe(
      'https://api.telegram.org',
    );
    expect(
      createTelegramConfig(
        configOf({ ...env, TELEGRAM_API_BASE_URL: 'http://stub:4011/' }),
      )?.apiBaseUrl,
    ).toBe('http://stub:4011');
  });
});

describe('TelegramClient.sendMessage', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);
  const client = new TelegramClient(CONFIG);

  const failure = async (): Promise<TelegramSendError> => {
    const error: unknown = await client
      .sendMessage(1, 'hi')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramSendError);
    expect(String(error)).not.toContain(TOKEN);
    return error as TelegramSendError;
  };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => {
      throw new Error('Unexpected fetch in this test');
    });
    vi.stubGlobal('fetch', fetchMock);
    warnSpy.mockClear();
  });
  afterEach(() => {
    for (const args of warnSpy.mock.calls)
      expect(args.map(String).join(' ')).not.toContain(TOKEN);
  });
  afterAll(() => vi.unstubAllGlobals());

  it('POSTs plain text to /bot<token>/sendMessage and returns the message id', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { ok: true, result: { message_id: 77 } }),
    );
    await expect(client.sendMessage(-100123, 'Alert')).resolves.toBe(77);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://stub.test/bot${TOKEN}/sendMessage`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: -100123,
      text: 'Alert',
      link_preview_options: { is_disabled: true },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [429, 'Too Many Requests: retry after 5', 'rate_limited', true],
    [502, 'Bad Gateway', 'server_error', true],
    [403, 'Forbidden: bot was blocked by the user', 'chat_unavailable', false],
    [400, 'Bad Request: chat not found', 'chat_unavailable', false],
    [401, 'Unauthorized', 'unauthorized', false],
    [400, 'Bad Request: message text is empty', 'rejected', false],
  ] as const)(
    'HTTP %i "%s" → %s (retryable %s)',
    async (status, description, kind, retryable) => {
      fetchMock.mockResolvedValueOnce(
        json(status, {
          ok: false,
          error_code: status,
          description,
          ...(status === 429 ? { parameters: { retry_after: 5 } } : {}),
        }),
      );
      const error = await failure();
      expect(error).toMatchObject({ kind, retryable, status });
      if (status === 429) expect(error.retryAfterSeconds).toBe(5);
    },
  );

  it('network failure and timeout are retryable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await failure()).toMatchObject({
      kind: 'network',
      retryable: true,
      status: null,
    });
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(timeout);
    expect(await failure()).toMatchObject({ kind: 'timeout', retryable: true });
    expect(TELEGRAM_SEND_TIMEOUT_MS).toBe(10_000);
  });

  it('a 200 without ok:true or a non-JSON body is a server error', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: false }));
    expect((await failure()).kind).toBe('server_error');
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    expect((await failure()).kind).toBe('server_error');
  });

  it('not configured: throws without a request', async () => {
    const error: unknown = await new TelegramClient(null)
      .sendMessage(1, 'hi')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'not_configured', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('telegramErrorKind maps 404 (bad token path) to unauthorized', () => {
    expect(telegramErrorKind(404, 'Not Found')).toBe('unauthorized');
  });
});
