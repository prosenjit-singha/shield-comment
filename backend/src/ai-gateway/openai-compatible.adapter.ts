import {
  type AiAdapterResult,
  type AiChatRequest,
  type AiProviderAdapter,
  postJson,
} from './ai-adapter.js';
import {
  AiGatewayError,
  EMPTY_CONTENT_REASON,
  markResponseFormatRefusal,
} from './ai-gateway.errors.js';
import type { AiProvider, AiProviderConfig } from './ai-provider.js';
import { acceptsTemperature } from './neon-model-catalog.js';

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

/**
 * `<base>/chat/completions`, trailing slashes ignored. Neon's base is the bare gateway host, so
 * `/v1` is appended unless the base already ends with it.
 */
export function chatCompletionsUrl(
  provider: AiProvider,
  baseUrl: string,
): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (provider === 'neon' && !base.endsWith('/v1')) base = `${base}/v1`;
  return `${base}/chat/completions`;
}

/** OpenAI Chat Completions request body. */
export function chatCompletionsBody(
  provider: AiProvider,
  request: Omit<AiChatRequest, 'signal'>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
  };
  if (request.maxTokens !== undefined) {
    // OpenAI deprecated `max_tokens` (reasoning models reject it); Neon + Gemini take `max_tokens`.
    body[provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] =
      request.maxTokens;
  }
  // Neon 400s on `temperature` for some models (Gemini 4 Carbon, Claude Haiku 5.5): leave it out.
  if (
    request.temperature !== undefined &&
    (provider !== 'neon' || acceptsTemperature(request.model))
  ) {
    body.temperature = request.temperature;
  }
  const format = request.responseFormat;
  if (format?.type === 'json_object') {
    body.response_format = { type: 'json_object' };
  } else if (format?.type === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: format.name,
        schema: format.schema,
        ...(format.strict !== undefined && { strict: format.strict }),
      },
    };
  }
  return body;
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** 2xx body → result; no choices / empty content → `unexpected_response`. */
export function parseChatCompletion(
  provider: AiProvider,
  requestedModel: string,
  body: unknown,
  status = 200,
): AiAdapterResult {
  const unexpected = (what: string, reason?: string) =>
    new AiGatewayError(
      'unexpected_response',
      `AI ${provider} ${status}: ${what}`,
      { status, provider, reason },
    );
  if (!isRecord(body)) throw unexpected('response is not a JSON object');
  const choice = Array.isArray(body.choices)
    ? (body.choices[0] as unknown)
    : undefined;
  if (!isRecord(choice)) throw unexpected('no choices in the response');
  const message = isRecord(choice.message) ? choice.message : {};
  const content = extractText(message.content);
  if (content.trim().length === 0)
    throw unexpected('empty message content', EMPTY_CONTENT_REASON);
  const usage = isRecord(body.usage) ? body.usage : undefined;
  return {
    model:
      typeof body.model === 'string' && body.model
        ? body.model
        : requestedModel,
    content,
    usage: usage
      ? {
          promptTokens: num(usage.prompt_tokens),
          completionTokens: num(usage.completion_tokens),
          totalTokens: num(usage.total_tokens),
        }
      : undefined,
    finishReason:
      typeof choice.finish_reason === 'string'
        ? choice.finish_reason
        : undefined,
  };
}

const NEON_FORMAT_REFUSAL = /structured output|response_format/i;

/**
 * OpenAI Chat Completions dialect: Neon AI gateway (unified `/v1`), OpenAI, and Google Gemini's
 * OpenAI-compatible endpoint. Bearer key, plain `fetch`, no SDK.
 */
export class OpenAiCompatibleAdapter implements AiProviderAdapter {
  async chat(
    config: AiProviderConfig,
    request: AiChatRequest,
  ): Promise<AiAdapterResult> {
    const { signal, ...rest } = request;
    try {
      const { status, body } = await postJson(
        config.provider,
        chatCompletionsUrl(config.provider, config.baseUrl),
        { Authorization: `Bearer ${config.apiKey}` },
        chatCompletionsBody(config.provider, rest),
        signal,
        [config.apiKey],
      );
      return parseChatCompletion(config.provider, request.model, body, status);
    } catch (error) {
      // Neon names no `param` (Claude Haiku 5.5: "Structured output is not supported …").
      throw request.responseFormat
        ? markResponseFormatRefusal(error, NEON_FORMAT_REFUSAL)
        : error;
    }
  }
}
