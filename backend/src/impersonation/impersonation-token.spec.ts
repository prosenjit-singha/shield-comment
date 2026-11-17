import {
  IMPERSONATION_SESSION_SECONDS,
  IMPERSONATION_TOKEN_TTL_SECONDS,
  generateImpersonationToken,
  hashImpersonationToken,
  impersonationRedirectUrl,
  impersonationSessionExpiry,
  impersonationTokenExpiry,
  isWellFormedImpersonationToken,
  redeemFailure,
} from './impersonation-token.js';

describe('impersonation tokens', () => {
  it('are 32 random bytes, base64url, and never repeat', () => {
    const tokens = Array.from({ length: 200 }, () =>
      generateImpersonationToken(),
    );
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(isWellFormedImpersonationToken(token)).toBe(true);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('hash is sha256 hex: deterministic, distinct per token, never the token itself', () => {
    expect(hashImpersonationToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const token = generateImpersonationToken();
    const hash = hashImpersonationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashImpersonationToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
    expect(hashImpersonationToken(generateImpersonationToken())).not.toBe(hash);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'short',
    'a'.repeat(44),
    `${'a'.repeat(42)}=`,
    `${'a'.repeat(42)}/`,
  ])('rejects malformed token %j', (token) => {
    expect(isWellFormedImpersonationToken(token)).toBe(false);
  });

  it('tokens live 60 s; impersonated sessions exactly 1 hour', () => {
    const t = new Date('2026-11-18T10:00:00.000Z');
    expect(IMPERSONATION_TOKEN_TTL_SECONDS).toBe(60);
    expect(impersonationTokenExpiry(t).toISOString()).toBe(
      '2026-11-18T10:01:00.000Z',
    );
    expect(IMPERSONATION_SESSION_SECONDS).toBe(3600);
    expect(impersonationSessionExpiry(t).toISOString()).toBe(
      '2026-11-18T11:00:00.000Z',
    );
  });

  describe('redeemFailure (expiry and reuse)', () => {
    const issued = new Date('2026-11-18T10:00:00.000Z');
    const expiresAt = impersonationTokenExpiry(issued);
    const at = (ms: number) => new Date(issued.getTime() + ms);

    it('accepts an unused token until just before it expires', () => {
      expect(redeemFailure({ expiresAt, usedAt: null }, issued)).toBeNull();
      expect(redeemFailure({ expiresAt, usedAt: null }, at(59_999))).toBeNull();
    });

    it('rejects it from expiresAt on', () => {
      expect(redeemFailure({ expiresAt, usedAt: null }, at(60_000))).toBe(
        'expired',
      );
      expect(redeemFailure({ expiresAt, usedAt: null }, at(3_600_000))).toBe(
        'expired',
      );
    });

    it('rejects a used token, even before expiry (single use)', () => {
      expect(redeemFailure({ expiresAt, usedAt: at(1_000) }, at(2_000))).toBe(
        'used',
      );
    });

    it('rejects an unknown token', () => {
      expect(redeemFailure(undefined, issued)).toBe('unknown');
    });
  });

  it('redirectUrl = client origin + /impersonate?token=…', () => {
    expect(
      impersonationRedirectUrl('http://app.localhost:5174', 'tok_-1'),
    ).toBe('http://app.localhost:5174/impersonate?token=tok_-1');
    expect(impersonationRedirectUrl('https://app.example.com/', 'x')).toBe(
      'https://app.example.com/impersonate?token=x',
    );
  });
});
