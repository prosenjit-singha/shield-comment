import type { EnvironmentVariables } from '../config/env.validation.js';
import { tokenCipherContext } from '../crypto/token-cipher.service.js';
import {
  AI_PROVIDERS,
  type AiProvider,
  type AiProviderConfig,
  DEFAULT_AI_BASE_URLS,
  DEFAULT_AI_MODELS,
} from './ai-provider.js';
import { AI_PROVIDER_KEY_ENV } from './env-ai-config.resolver.js';

/**
 * Pure rules of the DB-backed AI config (M5-T3, D16): per field DB → `.env` → default.
 * No Nest, no DB: `DbAiConfigResolver` reads the rows and calls these.
 */

/** The `.env` values the AI config falls back to. */
export type AiEnvSettings = Partial<
  Pick<
    EnvironmentVariables,
    | 'AI_PROVIDER'
    | 'AI_GATEWAY_MODEL'
    | 'NEON_AI_GATEWAY_BASE_URL'
    | 'NEON_AI_GATEWAY_TOKEN'
    | 'OPENAI_API_KEY'
    | 'GEMINI_API_KEY'
    | 'ANTHROPIC_API_KEY'
  >
>;

/** DI token for `AiEnvSettings` (e2e overrides it to test the `.env` fallback). */
export const AI_ENV_SETTINGS = Symbol('AI_ENV_SETTINGS');

/** Env var holding each provider's key (Neon's gateway token included). */
export const AI_KEY_ENV = {
  neon: 'NEON_AI_GATEWAY_TOKEN',
  ...AI_PROVIDER_KEY_ENV,
} as const satisfies Record<AiProvider, keyof AiEnvSettings>;

export type AiSettingSource = 'db' | 'env' | 'default';
export type AiKeySource = 'db' | 'env' | 'none';

/** The `ai_provider_settings` row values (`null` = no row / fall back). */
export interface StoredAiSettings {
  provider: AiProvider | null;
  model: string | null;
}

/** A DB key after decryption: the plaintext, or unreadable (cipher unset, wrong key, tampered). */
export type StoredAiKey =
  | { apiKey: string; last4: string; updatedAt: Date }
  | { unreadable: true; updatedAt: Date };

/** Effective key of one provider. `apiKey` is internal: never serialise it. */
export interface AiKeyState {
  apiKey: string | null;
  source: AiKeySource;
  last4: string | null;
  /** A DB key exists but cannot be decrypted (treated as unset; the `.env` key may apply). */
  unreadable: boolean;
  /** When the DB key was saved (`null` = no DB key). */
  updatedAt: Date | null;
}

export interface AiModelState {
  model: string;
  source: AiSettingSource;
}

export interface AiSettingsSnapshot {
  provider: AiProvider;
  providerSource: AiSettingSource;
  model: string;
  modelSource: AiSettingSource;
  /** Model that applies to each provider if it is (or becomes) the active one. */
  models: Record<AiProvider, AiModelState>;
  keys: Record<AiProvider, AiKeyState>;
  /** Neon gateway base URL: env only (no column). */
  neonBaseUrl: string | null;
  stored: StoredAiSettings;
}

/** Draft for the connection test: any field overrides the saved/effective value. */
export interface AiConfigDraft {
  provider?: AiProvider;
  model?: string;
  apiKey?: string;
}

const blank = (value: string | undefined): string | null =>
  value?.trim() || null;

/** AAD context of a stored AI key: `ai_provider_key:platform:<provider>` (a row moved to another provider fails). */
export function aiProviderKeyContext(provider: AiProvider): string {
  return tokenCipherContext('ai_provider_key', 'platform', provider);
}

/** The only part of a key ever shown again. Keys are ≥ 8 chars (DTO rule). */
export function keyLast4(apiKey: string): string {
  return apiKey.slice(-4);
}

export function envAiProvider(env: AiEnvSettings): AiProvider {
  return env.AI_PROVIDER ?? 'neon';
}

/**
 * Model for `provider`: the DB model if it belongs to that provider (DB provider, or the env
 * provider when the DB has none) → `AI_GATEWAY_MODEL` if `provider` is the env provider → default.
 * A model never leaks across providers (a Claude id is never sent to OpenAI).
 */
export function aiModelFor(
  provider: AiProvider,
  stored: StoredAiSettings,
  env: AiEnvSettings,
): AiModelState {
  const envProvider = envAiProvider(env);
  if (stored.model && (stored.provider ?? envProvider) === provider) {
    return { model: stored.model, source: 'db' };
  }
  const envModel = blank(env.AI_GATEWAY_MODEL);
  if (envModel && envProvider === provider) {
    return { model: envModel, source: 'env' };
  }
  return { model: DEFAULT_AI_MODELS[provider], source: 'default' };
}

/** API root of a provider; Neon's comes from env (`null` when unset). */
export function aiBaseUrlFor(
  provider: AiProvider,
  neonBaseUrl: string | null,
): string | null {
  return provider === 'neon' ? neonBaseUrl : DEFAULT_AI_BASE_URLS[provider];
}

function keyState(
  dbKey: StoredAiKey | undefined,
  envKey: string | null,
): AiKeyState {
  const unreadable = dbKey !== undefined && 'unreadable' in dbKey;
  const updatedAt = dbKey?.updatedAt ?? null;
  if (dbKey && 'apiKey' in dbKey) {
    return {
      apiKey: dbKey.apiKey,
      source: 'db',
      last4: dbKey.last4,
      unreadable: false,
      updatedAt,
    };
  }
  if (envKey) {
    return {
      apiKey: envKey,
      source: 'env',
      last4: envKey.length >= 4 ? keyLast4(envKey) : null,
      unreadable,
      updatedAt,
    };
  }
  return { apiKey: null, source: 'none', last4: null, unreadable, updatedAt };
}

/** Per field DB → `.env` → default. */
export function buildAiSettingsSnapshot(
  stored: StoredAiSettings,
  dbKeys: Partial<Record<AiProvider, StoredAiKey>>,
  env: AiEnvSettings,
): AiSettingsSnapshot {
  const provider = stored.provider ?? envAiProvider(env);
  const providerSource: AiSettingSource = stored.provider
    ? 'db'
    : env.AI_PROVIDER
      ? 'env'
      : 'default';
  const models = Object.fromEntries(
    AI_PROVIDERS.map((p) => [p, aiModelFor(p, stored, env)]),
  ) as Record<AiProvider, AiModelState>;
  const keys = Object.fromEntries(
    AI_PROVIDERS.map((p) => [
      p,
      keyState(dbKeys[p], blank(env[AI_KEY_ENV[p]])),
    ]),
  ) as Record<AiProvider, AiKeyState>;
  return {
    provider,
    providerSource,
    model: models[provider].model,
    modelSource: models[provider].source,
    models,
    keys,
    neonBaseUrl: blank(env.NEON_AI_GATEWAY_BASE_URL),
    stored: { ...stored },
  };
}

/** The config a call uses, or `null` when the active provider lacks its key (or Neon its base URL). */
export function snapshotConfig(
  snapshot: AiSettingsSnapshot,
): AiProviderConfig | null {
  return draftAiConfig(snapshot, {});
}

/**
 * Saved/effective config with a draft merged over it (connection test). A draft provider brings
 * its own effective model and key unless the draft names them. `null` = no key / no Neon base URL.
 */
export function draftAiConfig(
  snapshot: AiSettingsSnapshot,
  draft: AiConfigDraft,
): AiProviderConfig | null {
  const provider = draft.provider ?? snapshot.provider;
  const model = draft.model ?? snapshot.models[provider].model;
  const apiKey = draft.apiKey ?? snapshot.keys[provider].apiKey;
  const baseUrl = aiBaseUrlFor(provider, snapshot.neonBaseUrl);
  return apiKey && baseUrl ? { provider, model, apiKey, baseUrl } : null;
}
