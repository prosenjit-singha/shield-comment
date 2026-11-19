import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AiProviderAdapter,
  AiResponseFormat,
  AiUsage,
  ChatMessage,
} from './ai-adapter.js';
import {
  type AiErrorKind,
  AiGatewayError,
  AiGatewayNotConfiguredError,
  EMPTY_CONTENT_REASON,
  redactAiSecrets,
} from './ai-gateway.errors.js';
import { AnthropicAdapter } from './anthropic.adapter.js';
import {
  AI_CONFIG_RESOLVER,
  type AiConfigResolver,
  type AiProvider,
  type AiProviderConfig,
  DEFAULT_AI_MODELS,
} from './ai-provider.js';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter.js';

export type { AiResponseFormat, AiUsage, ChatMessage } from './ai-adapter.js';
export {
  AiGatewayError,
  AiGatewayNotConfiguredError,
} from './ai-gateway.errors.js';
export { extractText } from './openai-compatible.adapter.js';

/** Neon default model (kept for existing imports; per-provider defaults: `DEFAULT_AI_MODELS`). */
export const DEFAULT_AI_GATEWAY_MODEL = DEFAULT_AI_MODELS.neon;
/** Default per-call timeout for general callers. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Timeout for one moderation call (M5-T5/T12): a stuck provider should fail fast into the D2
 * BullMQ retries instead of holding a worker slot for 30 s.
 */
export const MODERATION_TIMEOUT_MS = 15_000;

/** Connection probe (M5-T2, D16 "Test connection"): one tiny fixed call. */
export const CONNECTION_TEST_TIMEOUT_MS = 10_000;
export const CONNECTION_TEST_MAX_TOKENS = 16;
export const CONNECTION_TEST_MESSAGES: readonly ChatMessage[] = [
  { role: 'user', content: 'Reply with the single word OK.' },
];

/**
 * Probe outcome. Never contains the key; `message` is the scrubbed provider message (≤ 300 chars).
 * `ok: true` = the provider accepted the key + model and answered 2xx (an empty reply cut off by
 * the tiny `max_tokens` still counts).
 */
export type AiConnectionTestResult =
  | { ok: true; provider: AiProvider; model: string; latencyMs: number }
  | {
      ok: false;
      kind: AiErrorKind;
      latencyMs: number;
      provider?: AiProvider;
      model?: string;
      message?: string;
    };

export interface ChatOptions {
  /** Overrides the resolved config's model for this call. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  responseFormat?: AiResponseFormat;
  /** Explicit provider config instead of the resolver (e.g. the M5-T6 golden-suite script). */
  config?: AiProviderConfig;
}

export interface ChatResult {
  provider: AiProvider;
  model: string;
  /** Non-empty text of the first choice. */
  content: string;
  usage?: AiUsage;
  finishReason?: string;
  /** Wall time of the provider call, ms. */
  latencyMs: number;
}

/**
 * The single LLM entry point. Config comes from the injected `AiConfigResolver` (env now, admin
 * settings from M5-T3) or `options.config`; the provider's adapter does the wire call.
 * Logs provider / model / status / kind / ms / token counts only: never prompts or replies.
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly adapters: Partial<Record<AiProvider, AiProviderAdapter>>;

  constructor(
    @Inject(AI_CONFIG_RESOLVER) private readonly resolver: AiConfigResolver,
  ) {
    const openAiCompatible = new OpenAiCompatibleAdapter();
    this.adapters = {
      neon: openAiCompatible,
      openai: openAiCompatible,
      google: openAiCompatible,
      anthropic: new AnthropicAdapter(),
    };
  }

  /** True when a provider is configured and has an adapter (a call can be attempted). */
  async isConfigured(): Promise<boolean> {
    const config = await this.resolver.resolve();
    return config !== null && this.adapters[config.provider] !== undefined;
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    const config = options.config ?? (await this.resolver.resolve());
    if (!config) throw new AiGatewayNotConfiguredError();
    const adapter = this.adapters[config.provider];
    if (!adapter) {
      throw new AiGatewayNotConfiguredError(
        `AI provider ${config.provider} is not supported yet (adapter pending)`,
        config.provider,
      );
    }
    const model = options.model ?? config.model;
    const started = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    try {
      const result = await adapter.chat(config, {
        model,
        messages,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        responseFormat: options.responseFormat,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const latencyMs = elapsed();
      this.logger.debug(
        `chat ok provider=${config.provider} model=${result.model} ms=${latencyMs} tokens=${result.usage?.promptTokens ?? '?'}/${result.usage?.completionTokens ?? '?'}`,
      );
      return { provider: config.provider, ...result, latencyMs };
    } catch (error) {
      const failure =
        error instanceof AiGatewayError
          ? error
          : new AiGatewayError(
              'unexpected_response',
              `AI ${config.provider}: unexpected failure`,
              { provider: config.provider },
            );
      this.logger.warn(
        `chat failed provider=${config.provider} model=${model} status=${failure.status ?? '-'} kind=${failure.kind} ms=${elapsed()}`,
      );
      throw failure;
    }
  }

  /**
   * "Test connection" probe for any provider: the saved config (resolver) or a draft `config`.
   * Never throws for provider failures: every `AiGatewayError` becomes `{ ok: false, kind }`.
   * Logs kind + ms only.
   */
  async testConnection(
    config?: AiProviderConfig,
  ): Promise<AiConnectionTestResult> {
    const target = config ?? (await this.resolver.resolve());
    if (!target) {
      this.logger.log('connection test failed kind=not_configured ms=0');
      return { ok: false, kind: 'not_configured', latencyMs: 0 };
    }
    const { provider, model } = target;
    const adapter = this.adapters[provider];
    if (!adapter) {
      this.logger.log('connection test failed kind=not_configured ms=0');
      return {
        ok: false,
        kind: 'not_configured',
        latencyMs: 0,
        provider,
        model,
      };
    }
    const started = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    try {
      await adapter.chat(target, {
        model,
        messages: [...CONNECTION_TEST_MESSAGES],
        maxTokens: CONNECTION_TEST_MAX_TOKENS,
        signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
      });
    } catch (error) {
      const latencyMs = elapsed();
      const failure =
        error instanceof AiGatewayError
          ? error
          : new AiGatewayError(
              'unexpected_response',
              `AI ${provider}: unexpected failure`,
              { provider },
            );
      const reachable =
        failure.kind === 'unexpected_response' &&
        failure.reason === EMPTY_CONTENT_REASON;
      if (!reachable) {
        this.logger.log(
          `connection test failed kind=${failure.kind} ms=${latencyMs}`,
        );
        return {
          ok: false,
          kind: failure.kind,
          latencyMs,
          provider,
          model,
          message: redactAiSecrets(failure.message, [target.apiKey]),
        };
      }
    }
    const latencyMs = elapsed();
    this.logger.log(`connection test ok ms=${latencyMs}`);
    return { ok: true, provider, model, latencyMs };
  }
}
