import {
  type ExecutionContext,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { MetaWebhookSignatureGuard } from './meta-webhook-signature.guard.js';
import { metaWebhookSignature } from './meta-webhook-signature.js';

const SECRET = 'meta-app-secret-0123456789abcdef';
const BODY = Buffer.from('{"object":"instagram","entry":[]}');

interface FakeRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

function contextFor(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('MetaWebhookSignatureGuard', () => {
  const guard = new MetaWebhookSignatureGuard({
    verifyToken: null,
    appSecret: SECRET,
  });

  it('lets a correctly signed raw body through', () => {
    const ctx = contextFor({
      rawBody: BODY,
      headers: { 'x-hub-signature-256': metaWebhookSignature(BODY, SECRET) },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it.each<[string, FakeRequest]>([
    ['missing header', { rawBody: BODY, headers: {} }],
    [
      'wrong signature',
      {
        rawBody: BODY,
        headers: {
          'x-hub-signature-256': metaWebhookSignature(
            BODY,
            'another-app-secret-0123456789',
          ),
        },
      },
    ],
    [
      'malformed header',
      { rawBody: BODY, headers: { 'x-hub-signature-256': 'sha256=abc' } },
    ],
    [
      'no raw body captured',
      {
        headers: { 'x-hub-signature-256': metaWebhookSignature(BODY, SECRET) },
      },
    ],
  ])('401 on %s (logs the reason, never the header)', (_label, request) => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    expect(() => guard.canActivate(contextFor(request))).toThrow(
      UnauthorizedException,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toMatch(/signature (missing|malformed|mismatch)/);
    const header = request.headers['x-hub-signature-256'];
    if (typeof header === 'string') expect(logged).not.toContain(header);
    warn.mockRestore();
  });

  it('503 when the Meta app secret is unset', () => {
    const disabled = new MetaWebhookSignatureGuard({
      verifyToken: 'verify-token-0123456789abcdef',
      appSecret: null,
    });
    const ctx = contextFor({
      rawBody: BODY,
      headers: { 'x-hub-signature-256': metaWebhookSignature(BODY, SECRET) },
    });
    expect(() => disabled.canActivate(ctx)).toThrow(
      ServiceUnavailableException,
    );
  });
});
