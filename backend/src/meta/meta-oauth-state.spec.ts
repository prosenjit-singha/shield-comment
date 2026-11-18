import {
  generateMetaOAuthState,
  isMetaOAuthReturnPath,
  isWellFormedMetaOAuthState,
  META_OAUTH_STATE_TTL_SECONDS,
  metaOAuthClientRedirect,
  metaOAuthStateKey,
  parseMetaOAuthStateData,
} from './meta-oauth-state.js';

const WS = '0192f5a4-7c3e-7a10-8b2c-3d4e5f6a7b8c';

describe('meta OAuth state helpers', () => {
  it('generates unique 43-char base64url states', () => {
    const states = new Set(
      Array.from({ length: 50 }, () => generateMetaOAuthState()),
    );
    expect(states.size).toBe(50);
    for (const s of states) expect(isWellFormedMetaOAuthState(s)).toBe(true);
  });

  it('rejects malformed states before Redis is touched', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'short',
      'a'.repeat(44),
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)}/`,
      ['a'.repeat(43)],
      42,
    ]) {
      expect(isWellFormedMetaOAuthState(bad)).toBe(false);
    }
  });

  it('keys Redis by the sha256 of the state, never the state itself', () => {
    const state = generateMetaOAuthState();
    const key = metaOAuthStateKey(state);
    expect(key).toMatch(/^meta:oauth-state:[0-9a-f]{64}$/);
    expect(key).not.toContain(state);
    expect(metaOAuthStateKey(state)).toBe(key);
    expect(metaOAuthStateKey(generateMetaOAuthState())).not.toBe(key);
  });

  it('uses a 10-minute TTL (D6)', () => {
    expect(META_OAUTH_STATE_TTL_SECONDS).toBe(600);
  });

  it('allowlists only /onboarding and /pages as return paths', () => {
    expect(isMetaOAuthReturnPath('/onboarding')).toBe(true);
    expect(isMetaOAuthReturnPath('/pages')).toBe(true);
    for (const bad of [
      '/dashboard',
      '//evil.example',
      'https://evil.example/pages',
      '/pages/',
      '',
      undefined,
    ]) {
      expect(isMetaOAuthReturnPath(bad)).toBe(false);
    }
  });

  describe('parseMetaOAuthStateData', () => {
    const valid = { userId: 'u1', workspaceId: WS, returnTo: '/pages' };

    it('parses what the service stores (workspace id lower-cased)', () => {
      expect(
        parseMetaOAuthStateData(
          JSON.stringify({ ...valid, workspaceId: WS.toUpperCase() }),
        ),
      ).toEqual(valid);
    });

    it('returns null for missing or corrupt values', () => {
      for (const raw of [
        null,
        '',
        'not json',
        'null',
        '"x"',
        JSON.stringify({ ...valid, userId: '' }),
        JSON.stringify({ ...valid, userId: 7 }),
        JSON.stringify({ ...valid, workspaceId: 'nope' }),
        JSON.stringify({ ...valid, returnTo: '/dashboard' }),
        JSON.stringify({ userId: 'u1', workspaceId: WS }),
      ]) {
        expect(parseMetaOAuthStateData(raw)).toBeNull();
      }
    });
  });

  describe('metaOAuthClientRedirect', () => {
    const origin = 'https://app.example.com';

    it('builds the success URL on the client origin', () => {
      expect(metaOAuthClientRedirect(origin, '/onboarding', { ok: true })).toBe(
        'https://app.example.com/onboarding?meta=connected',
      );
    });

    it('adds skipped=N only when Pages were skipped (M3-T5)', () => {
      expect(
        metaOAuthClientRedirect(origin, '/pages', { ok: true, skipped: 2 }),
      ).toBe('https://app.example.com/pages?meta=connected&skipped=2');
      expect(
        metaOAuthClientRedirect(origin, '/pages', { ok: true, skipped: 0 }),
      ).toBe('https://app.example.com/pages?meta=connected');
    });

    it('builds the error URL with the reason', () => {
      expect(
        metaOAuthClientRedirect(origin, '/pages', {
          ok: false,
          reason: 'access_denied',
        }),
      ).toBe('https://app.example.com/pages?meta=error&reason=access_denied');
    });

    it('ignores any path on the configured origin', () => {
      expect(
        metaOAuthClientRedirect('http://app.localhost:5174/x/', '/pages', {
          ok: true,
        }),
      ).toBe('http://app.localhost:5174/pages?meta=connected');
    });
  });
});
