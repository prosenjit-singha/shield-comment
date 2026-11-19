import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { TokenCipherModule } from '../crypto/token-cipher.module.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AI_CONFIG_RESOLVER } from './ai-provider.js';
import { AI_ENV_SETTINGS, type AiEnvSettings } from './ai-settings.rules.js';
import { DbAiConfigResolver } from './db-ai-config.resolver.js';

/** The `.env` side of the AI config (fallback per field behind the admin settings). */
export function aiEnvSettingsFromConfig(
  config: ConfigService<EnvironmentVariables, true>,
): AiEnvSettings {
  const get = <K extends keyof AiEnvSettings>(key: K) =>
    config.get(key, { infer: true }) as AiEnvSettings[K];
  return {
    AI_PROVIDER: get('AI_PROVIDER'),
    AI_GATEWAY_MODEL: get('AI_GATEWAY_MODEL'),
    NEON_AI_GATEWAY_BASE_URL: get('NEON_AI_GATEWAY_BASE_URL'),
    NEON_AI_GATEWAY_TOKEN: get('NEON_AI_GATEWAY_TOKEN'),
    OPENAI_API_KEY: get('OPENAI_API_KEY'),
    GEMINI_API_KEY: get('GEMINI_API_KEY'),
    ANTHROPIC_API_KEY: get('ANTHROPIC_API_KEY'),
  };
}

/**
 * LLM client (Neon AI gateway / OpenAI / Google / Anthropic). No HTTP routes; feature
 * modules import this and inject `AiGatewayService`. Config = `DbAiConfigResolver` (M5-T3: admin
 * settings in the DB, keys encrypted, `.env` fallback per field); needs the global `DbModule`.
 */
@Module({
  imports: [TokenCipherModule],
  providers: [
    AiGatewayService,
    {
      provide: AI_ENV_SETTINGS,
      inject: [ConfigService],
      useFactory: aiEnvSettingsFromConfig,
    },
    DbAiConfigResolver,
    { provide: AI_CONFIG_RESOLVER, useExisting: DbAiConfigResolver },
  ],
  exports: [AiGatewayService, DbAiConfigResolver, AI_ENV_SETTINGS],
})
export class AiGatewayModule {}
