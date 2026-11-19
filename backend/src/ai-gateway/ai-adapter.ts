import { AiGatewayError, aiErrorFromResponse } from './ai-gateway.errors.js';
import type { AiProvider, AiProviderConfig } from './ai-provider.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Structured output. `json_schema` → OpenAI-style `response_format.json_schema`
 * (`strict: true` asks the provider to enforce the schema); `json_object` = any JSON object.
 * A provider/model that refuses it answers `invalid_request` (M5-T5 falls back).
 */
export type AiResponseFormat =
  | {
      type: 'json_schema';
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    }
  | { type: 'json_object' };

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** What an adapter sends: config values already applied by `AiGatewayService`. */
export interface AiChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: AiResponseFormat;
  signal: AbortSignal;
}

export interface AiAdapterResult {
  model: string;
  /** Non-empty (adapters throw `unexpected_response` otherwise). */
  content: string;
  usage?: AiUsage;
  /** Provider's stop reason (`stop`, `length`, …) when given. */
  finishReason?: string;
}

/**
 * One wire dialect: `OpenAiCompatibleAdapter` (Neon, OpenAI, Google) and `AnthropicAdapter`
 * (native Messages API), registered per provider in `AiGatewayService`.
 */
export interface AiProviderAdapter {
  chat(
    config: AiProviderConfig,
    request: AiChatRequest,
  ): Promise<AiAdapterResult>;
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/** fetch/body-read failure → `timeout` or `network`. The original error (it names the URL) is dropped. */
export function aiTransportError(
  provider: AiProvider,
  error: unknown,
): AiGatewayError {
  return isTimeout(error)
    ? new AiGatewayError('timeout', `AI ${provider} request timed out`, {
        provider,
      })
    : new AiGatewayError('network', `AI ${provider} request failed (network)`, {
        provider,
      });
}

export interface JsonResponse {
  status: number;
  /** Parsed JSON, or `undefined` when the body is not JSON. */
  body: unknown;
}

/**
 * POSTs JSON and reads the JSON answer. Transport failures → `timeout` / `network`; non-2xx →
 * `aiErrorFromResponse` (kind by status/body, key scrubbed, `Retry-After`). Shared by adapters.
 */
export async function postJson(
  provider: AiProvider,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  signal: AbortSignal,
  secrets: readonly string[],
): Promise<JsonResponse> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    text = await res.text();
  } catch (error) {
    throw aiTransportError(provider, error);
  }
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    throw aiErrorFromResponse(provider, res.status, body, res.headers, secrets);
  }
  return { status: res.status, body };
}
