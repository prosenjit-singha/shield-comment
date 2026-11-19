import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  type AiConfigResolver,
  type AiProvider,
  type AiProviderConfig,
  DEFAULT_AI_BASE_URLS,
  DEFAULT_AI_MODELS,
} from './ai-provider.js';

/** Env var that holds each direct provider's key. */
export const AI_PROVIDER_KEY_ENV = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
} as const satisfies Record<
  Exclude<AiProvider, 'neon'>,
  keyof EnvironmentVariables
>;

/** Pure: env values → config, or `null` when the active provider lacks its key / base URL. */
export function aiConfigFromEnv(
  env: Partial<EnvironmentVariables>,
): AiProviderConfig | null {
  const provider: AiProvider = env.AI_PROVIDER ?? 'neon';
  const model = env.AI_GATEWAY_MODEL?.trim() || DEFAULT_AI_MODELS[provider];
  if (provider === 'neon') {
    const baseUrl = env.NEON_AI_GATEWAY_BASE_URL?.trim();
    const apiKey = env.NEON_AI_GATEWAY_TOKEN?.trim();
    return baseUrl && apiKey ? { provider, model, apiKey, baseUrl } : null;
  }
  const apiKey = env[AI_PROVIDER_KEY_ENV[provider]]?.trim();
  if (!apiKey) return null;
  return { provider, model, apiKey, baseUrl: DEFAULT_AI_BASE_URLS[provider] };
}

/** Env-only `AiConfigResolver` (M5-T1). M5-T3 keeps it as the fallback of the DB resolver. */
@Injectable()
export class EnvAiConfigResolver implements AiConfigResolver {
  private readonly config: AiProviderConfig | null;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const get = <K extends keyof EnvironmentVariables>(key: K) =>
      config.get(key, { infer: true });
    this.config = aiConfigFromEnv({
      AI_PROVIDER: get('AI_PROVIDER'),
      AI_GATEWAY_MODEL: get('AI_GATEWAY_MODEL'),
      NEON_AI_GATEWAY_BASE_URL: get('NEON_AI_GATEWAY_BASE_URL'),
      NEON_AI_GATEWAY_TOKEN: get('NEON_AI_GATEWAY_TOKEN'),
      OPENAI_API_KEY: get('OPENAI_API_KEY'),
      GEMINI_API_KEY: get('GEMINI_API_KEY'),
      ANTHROPIC_API_KEY: get('ANTHROPIC_API_KEY'),
    });
  }

  resolve(): Promise<AiProviderConfig | null> {
    return Promise.resolve(this.config ? { ...this.config } : null);
  }
}
