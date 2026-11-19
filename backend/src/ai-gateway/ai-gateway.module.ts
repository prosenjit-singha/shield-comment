import { Module } from '@nestjs/common';
import { AiGatewayService } from './ai-gateway.service.js';
import { AI_CONFIG_RESOLVER } from './ai-provider.js';
import { EnvAiConfigResolver } from './env-ai-config.resolver.js';

/**
 * LLM client (Neon AI gateway / OpenAI / Google; Anthropic in M5-T2). No HTTP routes; feature
 * modules import this and inject `AiGatewayService`. M5-T3 replaces the resolver with the
 * admin-settings one (env fallback).
 */
@Module({
  providers: [
    AiGatewayService,
    { provide: AI_CONFIG_RESOLVER, useClass: EnvAiConfigResolver },
  ],
  exports: [AiGatewayService],
})
export class AiGatewayModule {}
