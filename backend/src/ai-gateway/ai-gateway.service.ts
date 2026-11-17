import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';

/** Cheapest general chat model in the Neon catalog at wiring time (models.dev, Nov 2026). */
export const DEFAULT_AI_GATEWAY_MODEL = 'gpt-oss-20b';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Gateway catalog id (e.g. `gpt-oss-20b`, `claude-haiku-4-5`). Defaults to `AI_GATEWAY_MODEL`. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ChatResult {
  model: string;
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export class AiGatewayNotConfiguredError extends Error {
  constructor() {
    super(
      'AI gateway is not configured (NEON_AI_GATEWAY_BASE_URL, NEON_AI_GATEWAY_TOKEN)',
    );
    this.name = 'AiGatewayNotConfiguredError';
  }
}

export class AiGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Neon's `unavailable_reason`, e.g. `paid_plan_required` when the org has no AI credits. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'AiGatewayError';
  }
}

interface CompletionResponse {
  model?: string;
  choices?: { message?: { content?: unknown } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `content` is a string, or (some reasoning models) an array of parts; keep only text parts. */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

function errorDetails(body: unknown): { message?: string; reason?: string } {
  if (!isRecord(body)) return {};
  const inner = isRecord(body.error) ? body.error : body;
  const message = typeof inner.message === 'string' ? inner.message : undefined;
  const reasonSource = inner.unavailable_reason ?? body.unavailable_reason;
  const reason = typeof reasonSource === 'string' ? reasonSource : undefined;
  return { message, reason };
}

/**
 * Neon AI Gateway via its unified OpenAI-compatible Chat Completions route
 * (`${NEON_AI_GATEWAY_BASE_URL}/v1/chat/completions`). Plain `fetch`, no SDK.
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly baseUrl?: string;
  private readonly token?: string;
  private readonly defaultModel: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.baseUrl = config
      .get('NEON_AI_GATEWAY_BASE_URL', { infer: true })
      ?.replace(/\/+$/, '');
    this.token = config.get('NEON_AI_GATEWAY_TOKEN', { infer: true });
    this.defaultModel =
      config.get('AI_GATEWAY_MODEL', { infer: true }) ||
      DEFAULT_AI_GATEWAY_MODEL;
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    if (!this.baseUrl || !this.token) throw new AiGatewayNotConfiguredError();
    const model = options.model ?? this.defaultModel;
    const started = performance.now();
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        ...(options.maxTokens !== undefined && {
          max_tokens: options.maxTokens,
        }),
        ...(options.temperature !== undefined && {
          temperature: options.temperature,
        }),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const { message, reason } = errorDetails(body);
      throw new AiGatewayError(
        res.status,
        `AI gateway ${res.status}${reason ? ` (${reason})` : ''}: ${message ?? res.statusText}`,
        reason,
      );
    }
    const data = (isRecord(body) ? body : {}) as CompletionResponse;
    const content = extractText(data.choices?.[0]?.message?.content);
    const usage = data.usage;
    this.logger.debug(
      `chat ${model} ${Math.round(performance.now() - started)}ms tokens=${usage?.total_tokens ?? '?'}`,
    );
    return {
      model: data.model ?? model,
      content,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }
}
