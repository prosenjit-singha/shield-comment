import { tokenCipherContext } from '../crypto/token-cipher.service.js';
import { DEFAULT_AI_BASE_URLS, DEFAULT_AI_MODELS } from './ai-provider.js';
import {
  type AiEnvSettings,
  aiModelFor,
  aiProviderKeyContext,
  buildAiSettingsSnapshot,
  draftAiConfig,
  keyLast4,
  snapshotConfig,
  type StoredAiKey,
} from './ai-settings.rules.js';

const NONE = {
  provider: null,
  model: null,
  textImageModel: null,
  textImageEnabled: false,
} as const;
const AT = new Date('2026-11-19T08:00:00.000Z');
const dbKey = (apiKey: string): StoredAiKey => ({
  apiKey,
  last4: keyLast4(apiKey),
  updatedAt: AT,
});
const NEON_ENV: AiEnvSettings = {
  NEON_AI_GATEWAY_BASE_URL: 'https://neon.example',
  NEON_AI_GATEWAY_TOKEN: 'neon-env-token-1111',
};

describe('aiProviderKeyContext', () => {
  it('is a platform-scoped cipher context per provider', () => {
    expect(aiProviderKeyContext('openai')).toBe(
      'ai_provider_key:platform:openai',
    );
    expect(aiProviderKeyContext('openai')).toBe(
      tokenCipherContext('ai_provider_key', 'platform', 'openai'),
    );
    expect(aiProviderKeyContext('google')).not.toBe(
      aiProviderKeyContext('openai'),
    );
  });
});

describe('aiModelFor', () => {
  it('DB model only for its own provider (DB provider, else the env provider)', () => {
    const stored = { provider: 'anthropic' as const, model: 'claude-x' };
    expect(aiModelFor('anthropic', stored, {})).toEqual({
      model: 'claude-x',
      source: 'db',
    });
    expect(aiModelFor('openai', stored, {})).toEqual({
      model: DEFAULT_AI_MODELS.openai,
      source: 'default',
    });
    // No DB provider: the DB model belongs to the env provider.
    const modelOnly = { provider: null, model: 'gpt-x' };
    expect(aiModelFor('openai', modelOnly, { AI_PROVIDER: 'openai' })).toEqual({
      model: 'gpt-x',
      source: 'db',
    });
    expect(aiModelFor('neon', modelOnly, { AI_PROVIDER: 'openai' })).toEqual({
      model: DEFAULT_AI_MODELS.neon,
      source: 'default',
    });
  });

  it('AI_GATEWAY_MODEL only for the env provider', () => {
    const env: AiEnvSettings = {
      AI_PROVIDER: 'google',
      AI_GATEWAY_MODEL: ' gemini-x ',
    };
    expect(aiModelFor('google', NONE, env)).toEqual({
      model: 'gemini-x',
      source: 'env',
    });
    expect(aiModelFor('openai', NONE, env).source).toBe('default');
    expect(aiModelFor('neon', NONE, { AI_GATEWAY_MODEL: 'm' })).toEqual({
      model: 'm',
      source: 'env',
    });
  });
});

describe('buildAiSettingsSnapshot', () => {
  it('nothing anywhere: neon by default, no keys, not configured', () => {
    const s = buildAiSettingsSnapshot(NONE, {}, {});
    expect(s).toMatchObject({
      provider: 'neon',
      providerSource: 'default',
      model: DEFAULT_AI_MODELS.neon,
      modelSource: 'default',
      neonBaseUrl: null,
    });
    for (const key of Object.values(s.keys)) {
      expect(key).toEqual({
        apiKey: null,
        source: 'none',
        last4: null,
        unreadable: false,
        updatedAt: null,
      });
    }
    expect(snapshotConfig(s)).toBeNull();
  });

  it('env only = the M5-T1 behaviour', () => {
    const s = buildAiSettingsSnapshot(
      NONE,
      {},
      {
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-env-key-9876',
        AI_GATEWAY_MODEL: 'gpt-env',
      },
    );
    expect(s.providerSource).toBe('env');
    expect(s.keys.openai).toMatchObject({ source: 'env', last4: '9876' });
    expect(snapshotConfig(s)).toEqual({
      provider: 'openai',
      model: 'gpt-env',
      apiKey: 'sk-env-key-9876',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
    });
  });

  it('DB wins per field: provider, model, key; env fills the rest', () => {
    const s = buildAiSettingsSnapshot(
      { ...NONE, provider: 'anthropic' },
      { anthropic: dbKey('sk-ant-db-key-4321') },
      { AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'sk-ant-env-0000' },
    );
    expect(s).toMatchObject({
      provider: 'anthropic',
      providerSource: 'db',
      model: DEFAULT_AI_MODELS.anthropic,
      modelSource: 'default',
    });
    expect(s.keys.anthropic).toEqual({
      apiKey: 'sk-ant-db-key-4321',
      source: 'db',
      last4: '4321',
      unreadable: false,
      updatedAt: AT,
    });
    expect(snapshotConfig(s)?.apiKey).toBe('sk-ant-db-key-4321');
  });

  it('an unreadable DB key counts as unset: env key applies, flag kept', () => {
    const unreadable: StoredAiKey = { unreadable: true, updatedAt: AT };
    const withEnv = buildAiSettingsSnapshot(
      NONE,
      { openai: unreadable },
      { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-env-key-5555' },
    );
    expect(withEnv.keys.openai).toMatchObject({
      apiKey: 'sk-env-key-5555',
      source: 'env',
      unreadable: true,
    });
    const without = buildAiSettingsSnapshot(
      NONE,
      { openai: unreadable },
      { AI_PROVIDER: 'openai' },
    );
    expect(without.keys.openai).toMatchObject({
      apiKey: null,
      source: 'none',
      unreadable: true,
    });
    expect(snapshotConfig(without)).toBeNull();
  });

  it('Neon needs the env base URL even with a DB key', () => {
    const noUrl = buildAiSettingsSnapshot(
      NONE,
      { neon: dbKey('neon-db-token-2222') },
      {},
    );
    expect(snapshotConfig(noUrl)).toBeNull();
    const s = buildAiSettingsSnapshot(
      NONE,
      { neon: dbKey('neon-db-token-2222') },
      NEON_ENV,
    );
    expect(snapshotConfig(s)).toEqual({
      provider: 'neon',
      model: DEFAULT_AI_MODELS.neon,
      apiKey: 'neon-db-token-2222',
      baseUrl: 'https://neon.example',
    });
  });

  it('blank env values are ignored', () => {
    const s = buildAiSettingsSnapshot(
      NONE,
      {},
      {
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: '   ',
        AI_GATEWAY_MODEL: ' ',
      },
    );
    expect(s.keys.openai.source).toBe('none');
    expect(s.modelSource).toBe('default');
  });
});

describe('draftAiConfig', () => {
  const snapshot = buildAiSettingsSnapshot(
    { ...NONE, provider: 'openai', model: 'gpt-saved' },
    { openai: dbKey('sk-openai-db-1234') },
    { ...NEON_ENV, GEMINI_API_KEY: 'gemini-env-key-7777' },
  );

  it('empty draft = the saved config', () => {
    expect(draftAiConfig(snapshot, {})).toEqual({
      provider: 'openai',
      model: 'gpt-saved',
      apiKey: 'sk-openai-db-1234',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
    });
  });

  it('draft fields override; a draft provider brings its own model + key', () => {
    expect(draftAiConfig(snapshot, { model: 'gpt-draft' })?.model).toBe(
      'gpt-draft',
    );
    expect(draftAiConfig(snapshot, { apiKey: 'sk-draft-key-0000' })).toEqual(
      expect.objectContaining({ apiKey: 'sk-draft-key-0000' }),
    );
    expect(draftAiConfig(snapshot, { provider: 'google' })).toEqual({
      provider: 'google',
      model: DEFAULT_AI_MODELS.google,
      apiKey: 'gemini-env-key-7777',
      baseUrl: DEFAULT_AI_BASE_URLS.google,
    });
    expect(draftAiConfig(snapshot, { provider: 'neon' })?.baseUrl).toBe(
      'https://neon.example',
    );
  });

  it('null when the draft provider has no key', () => {
    expect(draftAiConfig(snapshot, { provider: 'anthropic' })).toBeNull();
    expect(
      draftAiConfig(snapshot, {
        provider: 'anthropic',
        apiKey: 'sk-ant-draft-1',
      })?.apiKey,
    ).toBe('sk-ant-draft-1');
  });
});
