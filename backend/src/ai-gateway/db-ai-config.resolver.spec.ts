import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { TokenCipherService } from '../crypto/token-cipher.service.js';
import { buildTokenKeyring } from '../crypto/token-keyring.js';
import type { Database } from '../db/database.js';
import { DEFAULT_AI_BASE_URLS } from './ai-provider.js';
import {
  type AiEnvSettings,
  aiProviderKeyContext,
} from './ai-settings.rules.js';
import {
  AI_CONFIG_CACHE_TTL_MS,
  type AiSettingsRows,
  DbAiConfigResolver,
} from './db-ai-config.resolver.js';

const AT = new Date('2026-11-19T08:00:00.000Z');
const cipher = new TokenCipherService(
  buildTokenKeyring({ key: randomBytes(32).toString('base64'), keyId: 'k1' }),
);
const otherCipher = new TokenCipherService(
  buildTokenKeyring({ key: randomBytes(32).toString('base64'), keyId: 'k2' }),
);
const disabledCipher = new TokenCipherService(null);

const keyRow = (
  provider: string,
  apiKey: string,
  using: TokenCipherService = cipher,
) => ({
  provider,
  keyCiphertext: using.encrypt(apiKey, aiProviderKeyContext('openai')),
  last4: apiKey.slice(-4),
  updatedAt: AT,
});

/** Feeds rows from memory instead of the database. */
class TestResolver extends DbAiConfigResolver {
  rows: AiSettingsRows = { settings: undefined, keys: [] };
  reads = 0;
  fail: Error | null = null;

  constructor(env: AiEnvSettings = {}, using: TokenCipherService = cipher) {
    super({} as Database, using, env);
  }

  protected override readRows(): Promise<AiSettingsRows> {
    this.reads += 1;
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve(structuredClone(this.rows));
  }
}

const settings = (provider: string | null, model: string | null) => ({
  provider,
  model,
  updatedAt: AT,
  updatedById: null,
});

describe('DbAiConfigResolver', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('DB provider + decrypted DB key win over env', async () => {
    const resolver = new TestResolver({
      AI_PROVIDER: 'neon',
      OPENAI_API_KEY: 'sk-env-key-0000',
    });
    resolver.rows = {
      settings: settings('openai', 'gpt-db'),
      keys: [keyRow('openai', 'sk-db-key-1234')],
    };
    expect(await resolver.resolve()).toEqual({
      provider: 'openai',
      model: 'gpt-db',
      apiKey: 'sk-db-key-1234',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
    });
  });

  it('empty DB → env fallback per field', async () => {
    const resolver = new TestResolver({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-env-key-0000',
      AI_GATEWAY_MODEL: 'gpt-env',
    });
    expect(await resolver.resolve()).toMatchObject({
      provider: 'openai',
      model: 'gpt-env',
      apiKey: 'sk-env-key-0000',
    });
    const state = await resolver.state();
    expect(state.providerSource).toBe('env');
    expect(state.keys.openai.source).toBe('env');
    expect(state.updatedAt).toBeNull();
  });

  it('caches for the TTL and re-reads after it', async () => {
    const resolver = new TestResolver({ OPENAI_API_KEY: 'sk-env-key-0000' });
    resolver.rows.settings = settings('openai', null);
    await resolver.resolve();
    await resolver.resolve();
    expect(resolver.reads).toBe(1);
    resolver.rows.settings = settings('openai', 'gpt-new');
    vi.setSystemTime(AT.getTime() + AI_CONFIG_CACHE_TTL_MS - 1);
    expect((await resolver.resolve())?.model).not.toBe('gpt-new');
    vi.setSystemTime(AT.getTime() + AI_CONFIG_CACHE_TTL_MS + 1);
    expect((await resolver.resolve())?.model).toBe('gpt-new');
    expect(resolver.reads).toBe(2);
  });

  it('invalidate() forces the next resolve to read the DB', async () => {
    const resolver = new TestResolver({ OPENAI_API_KEY: 'sk-env-key-0000' });
    resolver.rows.settings = settings('openai', 'gpt-a');
    expect((await resolver.resolve())?.model).toBe('gpt-a');
    resolver.rows.settings = settings('openai', 'gpt-b');
    resolver.invalidate();
    expect((await resolver.resolve())?.model).toBe('gpt-b');
    expect(resolver.reads).toBe(2);
  });

  it('a read that overlaps an invalidate() is not cached', async () => {
    const resolver = new TestResolver({ OPENAI_API_KEY: 'sk-env-key-0000' });
    resolver.rows.settings = settings('openai', 'gpt-old');
    const pending = resolver.resolve();
    resolver.invalidate();
    await pending;
    resolver.rows.settings = settings('openai', 'gpt-new');
    expect((await resolver.resolve())?.model).toBe('gpt-new');
  });

  it('returns copies (callers cannot mutate the cache)', async () => {
    const resolver = new TestResolver({ OPENAI_API_KEY: 'sk-env-key-0000' });
    resolver.rows.settings = settings('openai', null);
    const first = await resolver.resolve();
    first!.model = 'mutated';
    expect((await resolver.resolve())?.model).not.toBe('mutated');
  });

  it('undecryptable DB key → unset (env key applies), logged once with reason only', async () => {
    const resolver = new TestResolver({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-env-key-0000',
    });
    resolver.rows.keys = [keyRow('openai', 'sk-other-key-9999', otherCipher)];
    expect((await resolver.resolve())?.apiKey).toBe('sk-env-key-0000');
    resolver.invalidate();
    const state = await resolver.state();
    expect(state.keys.openai).toMatchObject({
      source: 'env',
      unreadable: true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toBe(
      'AI key unreadable provider=openai reason=unknown_key; treated as unset',
    );
    expect(line).not.toContain('sk-');
  });

  it('cipher unset → DB keys unreadable, no env key → null', async () => {
    const resolver = new TestResolver(
      { AI_PROVIDER: 'openai' },
      disabledCipher,
    );
    resolver.rows.keys = [keyRow('openai', 'sk-db-key-1234')];
    expect(await resolver.resolve()).toBeNull();
    expect(String(warn.mock.calls[0]![0])).toContain(
      'reason=cipher_not_configured',
    );
  });

  it('a ciphertext copied to another provider row fails (context = provider)', async () => {
    const resolver = new TestResolver({ AI_PROVIDER: 'google' });
    // keyRow encrypts with the openai context; stored under google it must not decrypt.
    resolver.rows.keys = [keyRow('google', 'sk-moved-key-1234')];
    expect(await resolver.resolve()).toBeNull();
    expect((await resolver.state()).keys.google.unreadable).toBe(true);
  });

  it('DB read failure → last resolved config, else the env config; nothing cached', async () => {
    const resolver = new TestResolver({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-env-key-0000',
    });
    resolver.fail = new Error('connection refused sk-secret');
    expect(await resolver.resolve()).toMatchObject({
      apiKey: 'sk-env-key-0000',
    });
    expect(String(warn.mock.calls[0]![0])).toBe(
      'AI settings read failed (Error); using the .env config',
    );
    resolver.fail = null;
    resolver.rows = {
      settings: settings('openai', 'gpt-db'),
      keys: [keyRow('openai', 'sk-db-key-1234')],
    };
    expect((await resolver.resolve())?.model).toBe('gpt-db');
    resolver.invalidate();
    resolver.fail = new Error('down');
    // invalidate() dropped the cache, so the env config is used again.
    expect((await resolver.resolve())?.model).not.toBe('gpt-db');
  });

  it('DB read failure after expiry reuses the stale config', async () => {
    const resolver = new TestResolver({ AI_PROVIDER: 'openai' });
    resolver.rows = {
      settings: settings('openai', 'gpt-db'),
      keys: [keyRow('openai', 'sk-db-key-1234')],
    };
    await resolver.resolve();
    vi.setSystemTime(AT.getTime() + AI_CONFIG_CACHE_TTL_MS + 1);
    resolver.fail = new Error('down');
    expect(await resolver.resolve()).toMatchObject({
      model: 'gpt-db',
      apiKey: 'sk-db-key-1234',
    });
  });

  it('ignores rows with an unknown provider', async () => {
    const resolver = new TestResolver({});
    resolver.rows = {
      settings: settings('mistral', null),
      keys: [{ ...keyRow('openai', 'sk-db-key-1234'), provider: 'mistral' }],
    };
    const state = await resolver.state();
    expect(state.provider).toBe('neon');
    expect(state.providerSource).toBe('default');
  });
});
