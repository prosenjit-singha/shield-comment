import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  createEmailSettings,
  EMAIL_SEND_TIMEOUT_MS,
  EmailNotConfiguredError,
  EmailSendError,
  EmailService,
  RESEND_EMAILS_URL,
  type EmailMessage,
} from './email.service.js';

const API_KEY = 're_test_0123456789abcdef';
const RESEND = { apiKey: API_KEY, from: 'ShieldComment <alerts@example.com>' };
const MESSAGE: EmailMessage = {
  to: 'owner@shop.com.bd',
  subject: 'New reply',
  html: '<p>Hi</p>',
  text: 'Hi',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sendError(service: EmailService): Promise<EmailSendError> {
  const error: unknown = await service.send(MESSAGE).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(EmailSendError);
  return error as EmailSendError;
}

describe('EmailService', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const logSpy = vi.spyOn(Logger.prototype, 'log').mockReturnValue(undefined);
  const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);
  const errorSpy = vi
    .spyOn(Logger.prototype, 'error')
    .mockReturnValue(undefined);
  const service = new EmailService({ resend: RESEND, production: true });

  beforeEach(() => {
    fetchMock.mockReset();
    // Any request a test didn't arm fails loudly.
    fetchMock.mockImplementation(() => {
      throw new Error('Unexpected fetch in this test');
    });
    vi.stubGlobal('fetch', fetchMock);
    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
  });
  afterEach(() => {
    // Logs never carry the API key; provider sends log the domain, not the address.
    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const args of spy.mock.calls) {
        expect(args.map(String).join(' ')).not.toContain(API_KEY);
      }
    }
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('POSTs one JSON email to Resend with a bearer key and returns the id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'em_123' }));
    await expect(
      service.send({ ...MESSAGE, idempotencyKey: 'ticket-reply/42' }),
    ).resolves.toEqual({ delivered: true, id: 'em_123' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(RESEND_EMAILS_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': 'ticket-reply/42',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init?.body as string)).toEqual({
      from: RESEND.from,
      to: ['owner@shop.com.bd'],
      subject: 'New reply',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
    const logged = logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    expect(logged).toContain('domain=shop.com.bd id=em_123');
    expect(logged).not.toContain('owner@');
  });

  it('sends no Idempotency-Key header without a key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'em_1' }));
    await service.send(MESSAGE);
    expect(fetchMock.mock.calls[0]![1]?.headers).not.toHaveProperty(
      'Idempotency-Key',
    );
  });

  it.each([400, 401, 403, 422])(
    '%i is a non-retryable error without the recipient address',
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(status, {
          statusCode: status,
          name: 'validation_error',
          message: `Invalid \`to\` field: ${MESSAGE.to}`,
        }),
      );
      const error = await sendError(service);
      expect(error.retryable).toBe(false);
      expect(error.status).toBe(status);
      expect(error.message).toBe(
        `Resend ${status}: Invalid \`to\` field: [recipient]`,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        `email failed: domain=shop.com.bd status=${status} retryable=false`,
      );
    },
  );

  it.each([429, 500, 502, 503])('%i is retryable', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response('oops', { status }));
    const error = await sendError(service);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(status);
    expect(error.message).toBe(`Resend ${status}: HTTP ${status}`);
  });

  it('a timeout is retryable and names the limit', async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );
    const error = await sendError(service);
    expect(error).toMatchObject({ retryable: true, status: null });
    expect(error.message).toBe(
      `Resend: timed out after ${EMAIL_SEND_TIMEOUT_MS} ms`,
    );
  });

  it('a network failure is retryable and hides the original error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${API_KEY}`));
    const error = await sendError(service);
    expect(error).toMatchObject({ retryable: true, status: null });
    expect(error.message).toBe('Resend: request failed');
  });

  it('a 2xx without an id is not retried (it may have been sent)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const error = await sendError(service);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('without an email id');
  });

  describe('not configured', () => {
    it('outside production logs to + subject and resolves without sending', async () => {
      const dev = new EmailService({ resend: null, production: false });
      dev.onModuleInit();
      expect(dev.enabled).toBe(false);
      await expect(dev.send(MESSAGE)).resolves.toEqual({
        delivered: false,
        reason: 'not_configured',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        'email not sent (not configured): to=owner@shop.com.bd subject="New reply"',
      );
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('in production logs once at boot and every send throws', async () => {
      const prod = new EmailService({ resend: null, production: true });
      prod.onModuleInit();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      await expect(prod.send(MESSAGE)).rejects.toBeInstanceOf(
        EmailNotConfiguredError,
      );
      await expect(prod.send(MESSAGE)).rejects.toThrow(
        'Email is not configured (RESEND_API_KEY, EMAIL_FROM)',
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a configured service logs nothing at boot', () => {
      service.onModuleInit();
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});

describe('createEmailSettings', () => {
  const settings = (env: Partial<EnvironmentVariables>) =>
    createEmailSettings({
      get: (key: keyof EnvironmentVariables) => env[key],
    } as unknown as ConfigService<EnvironmentVariables, true>);

  it('builds the Resend config only with key + from', () => {
    expect(
      settings({ RESEND_API_KEY: API_KEY, EMAIL_FROM: RESEND.from }),
    ).toEqual({ resend: RESEND, production: false });
    expect(settings({ RESEND_API_KEY: API_KEY })).toEqual({
      resend: null,
      production: false,
    });
  });

  it('flags production from NODE_ENV', () => {
    expect(
      settings({ NODE_ENV: 'production' as EnvironmentVariables['NODE_ENV'] })
        .production,
    ).toBe(true);
  });
});
