import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { DEFAULT_AI_BASE_URLS, DEFAULT_AI_MODELS } from './ai-provider.js';
import {
  aiConfigFromEnv,
  EnvAiConfigResolver,
} from './env-ai-config.resolver.js';

const NEON = {
  NEON_AI_GATEWAY_BASE_URL: 'https://br-x-api.ai.c-1.aws.neon.tech',
  NEON_AI_GATEWAY_TOKEN: 'nt_live_neon_token',
};

describe('aiConfigFromEnv', () => {
  it('defaults to the Neon gateway with its default model', () => {
    expect(aiConfigFromEnv(NEON)).toEqual({
      provider: 'neon',
      model: 'gpt-oss-20b',
      apiKey: 'nt_live_neon_token',
      baseUrl: 'https://br-x-api.ai.c-1.aws.neon.tech',
    });
  });

  it('is not configured when Neon lacks its token or base URL', () => {
    expect(aiConfigFromEnv({})).toBeNull();
    expect(
      aiConfigFromEnv({
        NEON_AI_GATEWAY_BASE_URL: NEON.NEON_AI_GATEWAY_BASE_URL,
      }),
    ).toBeNull();
    expect(
      aiConfigFromEnv({ NEON_AI_GATEWAY_TOKEN: NEON.NEON_AI_GATEWAY_TOKEN }),
    ).toBeNull();
    expect(
      aiConfigFromEnv({ ...NEON, NEON_AI_GATEWAY_TOKEN: '  ' }),
    ).toBeNull();
  });

  it.each([
    ['openai', 'OPENAI_API_KEY'],
    ['google', 'GEMINI_API_KEY'],
    ['anthropic', 'ANTHROPIC_API_KEY'],
  ] as const)('%s uses %s, its base URL and default model', (provider, key) => {
    expect(
      aiConfigFromEnv({ ...NEON, AI_PROVIDER: provider, [key]: 'key-123456' }),
    ).toEqual({
      provider,
      model: DEFAULT_AI_MODELS[provider],
      apiKey: 'key-123456',
      baseUrl: DEFAULT_AI_BASE_URLS[provider],
    });
    // Neon vars don't configure another provider.
    expect(aiConfigFromEnv({ ...NEON, AI_PROVIDER: provider })).toBeNull();
  });

  it('takes AI_GATEWAY_MODEL for the active provider', () => {
    expect(
      aiConfigFromEnv({
        AI_PROVIDER: 'google',
        GEMINI_API_KEY: 'AIza-key',
        AI_GATEWAY_MODEL: 'gemini-2.5-flash',
      })?.model,
    ).toBe('gemini-2.5-flash');
    expect(aiConfigFromEnv({ ...NEON, AI_GATEWAY_MODEL: ' ' })?.model).toBe(
      'gpt-oss-20b',
    );
  });
});

describe('EnvAiConfigResolver', () => {
  function resolver(values: Partial<EnvironmentVariables>) {
    const config = {
      get: (key: keyof EnvironmentVariables) => values[key],
    } as unknown as ConfigService<EnvironmentVariables, true>;
    return new EnvAiConfigResolver(config);
  }

  it('resolves the env config, a fresh copy per call', async () => {
    const r = resolver({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-key',
    });
    const first = await r.resolve();
    expect(first).toMatchObject({ provider: 'openai', apiKey: 'sk-test-key' });
    if (first) first.model = 'mutated';
    expect((await r.resolve())?.model).toBe(DEFAULT_AI_MODELS.openai);
  });

  it('resolves null when nothing is set', async () => {
    await expect(resolver({}).resolve()).resolves.toBeNull();
  });
});
