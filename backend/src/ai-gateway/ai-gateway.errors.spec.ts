import {
  AiGatewayError,
  AiGatewayNotConfiguredError,
  aiErrorDetails,
  aiErrorFromResponse,
  aiErrorKind,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  redactAiSecrets,
} from './ai-gateway.errors.js';

const err = (body: Record<string, unknown>) => ({ error: body });
const ant = (type: string, message: string, extra = {}) => ({
  type: 'error',
  error: { type, message, ...extra },
});

describe('aiErrorKind', () => {
  it.each([
    [402, {}, 'payment_required'],
    [401, err({ message: 'Incorrect API key' }), 'auth'],
    [
      403,
      err({
        message: 'Model not enabled',
        unavailable_reason: 'paid_plan_required',
      }),
      'payment_required',
    ],
    [
      403,
      { message: 'no', unavailable_reason: 'paid_plan_required' },
      'payment_required',
    ],
    [403, err({ message: 'Forbidden region' }), 'auth'],
    [
      429,
      err({ type: 'insufficient_quota', code: 'insufficient_quota' }),
      'payment_required',
    ],
    [
      429,
      err({ type: 'requests', code: 'rate_limit_exceeded' }),
      'rate_limited',
    ],
    [
      429,
      [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }],
      'rate_limited',
    ],
    [
      400,
      err({ param: 'response_format', code: 'invalid_request_error' }),
      'invalid_request',
    ],
    [
      400,
      [
        {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            details: [{ reason: 'API_KEY_INVALID' }],
          },
        },
      ],
      'auth',
    ],
    [404, err({ code: 'model_not_found' }), 'invalid_request'],
    [422, {}, 'invalid_request'],
    [413, undefined, 'invalid_request'],
    [408, undefined, 'transient'],
    [500, undefined, 'transient'],
    [503, 'Service Unavailable', 'transient'],
    [302, undefined, 'unexpected_response'],
    // Anthropic `{ type: 'error', error: { type, message } }` (M5-T2).
    [401, ant('authentication_error', 'invalid x-api-key'), 'auth'],
    [403, ant('permission_error', 'no'), 'auth'],
    [402, ant('billing_error', 'billing'), 'payment_required'],
    [
      400,
      ant('invalid_request_error', 'Your credit balance is too low to access'),
      'payment_required',
    ],
    [400, ant('invalid_request_error', 'messages: empty'), 'invalid_request'],
    [404, ant('not_found_error', 'model: x'), 'invalid_request'],
    [413, ant('request_too_large', 'too big'), 'invalid_request'],
    [429, ant('rate_limit_error', 'slow'), 'rate_limited'],
    [
      429,
      ant('rate_limit_error', 'cap', {
        details: { error_code: 'enforced_spend_limit_reached' },
      }),
      'payment_required',
    ],
    [500, ant('api_error', 'oops'), 'transient'],
    [529, ant('overloaded_error', 'Overloaded'), 'transient'],
  ] as const)('%i %j → %s', (status, body, kind) => {
    expect(aiErrorKind(status, body)).toBe(kind);
  });
});

describe('aiErrorDetails', () => {
  it('reads OpenAI, Neon, Gemini and Anthropic error shapes', () => {
    expect(
      aiErrorDetails(
        err({
          message: 'bad',
          type: 'invalid_request_error',
          param: 'response_format',
          code: null,
        }),
      ),
    ).toEqual({
      message: 'bad',
      reason: 'invalid_request_error',
      type: 'invalid_request_error',
      code: undefined,
      param: 'response_format',
    });
    expect(
      aiErrorDetails({
        message: 'off',
        unavailable_reason: 'paid_plan_required',
      }),
    ).toMatchObject({ message: 'off', reason: 'paid_plan_required' });
    expect(
      aiErrorDetails([
        {
          error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' },
        },
      ]),
    ).toMatchObject({
      message: 'quota',
      reason: 'RESOURCE_EXHAUSTED',
      code: '429',
    });
    expect(
      aiErrorDetails(
        ant('rate_limit_error', 'cap', {
          details: { error_code: 'enforced_spend_limit_reached' },
        }),
      ),
    ).toEqual({
      message: 'cap',
      reason: 'enforced_spend_limit_reached',
      type: 'rate_limit_error',
      code: 'enforced_spend_limit_reached',
      param: undefined,
    });
    expect(aiErrorDetails(ant('overloaded_error', 'Overloaded'))).toMatchObject(
      { reason: 'overloaded_error', type: 'overloaded_error' },
    );
    expect(aiErrorDetails('<html>')).toEqual({});
  });
});

describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-11-19T10:00:00Z');

  it('reads delta-seconds, an HTTP date and retry-after-ms', () => {
    expect(parseRetryAfter('7', NOW)).toBe(7000);
    expect(parseRetryAfter('1.5', NOW)).toBe(1500);
    expect(parseRetryAfter('Thu, 19 Nov 2026 10:00:20 GMT', NOW)).toBe(20_000);
    expect(parseRetryAfter('7', NOW, '250')).toBe(250);
  });

  it('clamps to [0, MAX] and ignores missing or junk values', () => {
    expect(parseRetryAfter('86400', NOW)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('Thu, 19 Nov 2026 09:00:00 GMT', NOW)).toBe(0);
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
    expect(parseRetryAfter('-5', NOW)).toBeUndefined();
  });
});

describe('redactAiSecrets', () => {
  it('removes the sent key and key-shaped strings', () => {
    expect(
      redactAiSecrets('key my-secret-key-1 is wrong', ['my-secret-key-1']),
    ).toBe('key [redacted] is wrong');
    expect(
      redactAiSecrets(
        'sk-proj-ABCDEFGHIJKLMNOPQRSTUV nt_live_abcdefghij AIzaSyA1234567890abcdefghijk sk-ant-api03-abcdefghijklmnop',
      ),
    ).toBe('[redacted] [redacted] [redacted] [redacted]');
  });
});

describe('aiErrorFromResponse', () => {
  const headers = (h: Record<string, string> = {}) => new Headers(h);

  it('builds a scrubbed, capped message with kind, status, reason and param', () => {
    const e = aiErrorFromResponse(
      'openai',
      400,
      err({
        message: `Invalid schema for response_format (key sk-test-SECRET-123): ${'x'.repeat(400)}`,
        type: 'invalid_request_error',
        param: 'response_format',
      }),
      headers(),
      ['sk-test-SECRET-123'],
    );
    expect(e).toBeInstanceOf(AiGatewayError);
    expect(e).toMatchObject({
      kind: 'invalid_request',
      status: 400,
      provider: 'openai',
      reason: 'invalid_request_error',
      param: 'response_format',
      retryable: false,
    });
    expect(e.message).not.toContain('sk-test-SECRET-123');
    expect(e.message.length).toBeLessThan(400);
    expect(e.message).toMatch(/^AI openai 400 \(invalid_request_error\): /);
  });

  it('passes Retry-After on rate limits only', () => {
    const limited = aiErrorFromResponse(
      'neon',
      429,
      {},
      headers({ 'Retry-After': '3' }),
    );
    expect(limited).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 3000,
      retryable: true,
    });
    const quota = aiErrorFromResponse(
      'openai',
      429,
      err({ code: 'insufficient_quota' }),
      headers({ 'Retry-After': '3' }),
    );
    expect(quota).toMatchObject({ kind: 'payment_required', retryable: false });
    expect(quota.retryAfterMs).toBeUndefined();
  });
});

describe('AiGatewayNotConfiguredError', () => {
  it('is an AiGatewayError with kind not_configured, not retryable', () => {
    const e = new AiGatewayNotConfiguredError();
    expect(e).toBeInstanceOf(AiGatewayError);
    expect(e).toMatchObject({
      kind: 'not_configured',
      status: null,
      retryable: false,
    });
  });
});
