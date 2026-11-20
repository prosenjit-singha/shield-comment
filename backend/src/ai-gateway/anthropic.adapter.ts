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
import type { AiProviderConfig } from './ai-provider.js';

/**
 * Anthropic Messages API version (`anthropic-version` header). `2026-10-21` is current: it
 * rejects `temperature` / `top_p` / `top_k` on every model (400), so this adapter never sends
 * `temperature` (Claude 4.7+ models only accept the default anyway).
 */
export const ANTHROPIC_API_VERSION = '2026-10-21';

/** `max_tokens` is required by Anthropic; used when the caller sets none. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

/**
 * Anthropic has no "any JSON object" mode (`output_config.format` needs a closed schema), so
 * `json_object` becomes this system instruction.
 */
export const ANTHROPIC_JSON_OBJECT_INSTRUCTION =
  'Respond with a single JSON object only: no prose, no Markdown code fences.';

/** Message mentions of a refused / unsupported structured-output schema. */
const SCHEMA_REFUSAL =
  /output_config|output_format|json[_ ]?schema|\bschema\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** `<base>/v1/messages`, trailing slashes ignored; a base already ending in `/v1` is kept. */
export function anthropicMessagesUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

/**
 * Messages API request body. `system` turns → top-level `system` (joined by a blank line);
 * `user` / `assistant` → `messages` (the API merges consecutive same-role turns itself). The
 * conversation must start with `user`: anything else is refused locally as `invalid_request`.
 * `json_schema` → `output_config.format` (GA JSON outputs; the schema is always enforced, so
 * `strict` and `name` are not sent); `json_object` → an extra system instruction.
 */
export function anthropicMessagesBody(
  request: Omit<AiChatRequest, 'signal'>,
): Record<string, unknown> {
  const system: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') system.push(message.content);
    else messages.push({ role: message.role, content: message.content });
  }
  if (messages[0]?.role !== 'user') {
    throw new AiGatewayError(
      'invalid_request',
      'AI anthropic: the conversation must start with a user message',
      { provider: 'anthropic' },
    );
  }
  const format = request.responseFormat;
  if (format?.type === 'json_object') {
    system.push(ANTHROPIC_JSON_OBJECT_INSTRUCTION);
  }
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system.length > 0) body.system = system.join('\n\n');
  if (format?.type === 'json_schema') {
    body.output_config = {
      format: { type: 'json_schema', schema: format.schema },
    };
  }
  return body;
}

/** 2xx body → result: text blocks joined; no text → `unexpected_response`. */
export function parseAnthropicMessage(
  requestedModel: string,
  body: unknown,
  status = 200,
): AiAdapterResult {
  const unexpected = (what: string, reason?: string) =>
    new AiGatewayError(
      'unexpected_response',
      `AI anthropic ${status}: ${what}`,
      { status, provider: 'anthropic', reason },
    );
  if (!isRecord(body)) throw unexpected('response is not a JSON object');
  if (!Array.isArray(body.content)) {
    throw unexpected('no content in the response');
  }
  const content = body.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
  const finishReason =
    typeof body.stop_reason === 'string' ? body.stop_reason : undefined;
  if (content.trim().length === 0) {
    throw unexpected(
      `empty message content${finishReason ? ` (stop_reason ${finishReason})` : ''}`,
      EMPTY_CONTENT_REASON,
    );
  }
  const usage = isRecord(body.usage) ? body.usage : undefined;
  // `input_tokens` excludes cached prompt tokens; count them as prompt tokens too.
  const promptTokens = usage
    ? num(usage.input_tokens) +
      num(usage.cache_creation_input_tokens) +
      num(usage.cache_read_input_tokens)
    : 0;
  const completionTokens = usage ? num(usage.output_tokens) : 0;
  return {
    model:
      typeof body.model === 'string' && body.model
        ? body.model
        : requestedModel,
    content,
    usage: usage
      ? {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        }
      : undefined,
    finishReason,
  };
}

/**
 * Native Anthropic Messages API (`POST /v1/messages`), plain `fetch` like the other adapters
 * (the gateway stays provider-neutral, no SDK). Errors map onto the M5-T1 kinds through
 * `aiErrorFromResponse`; a refused `output_config.format` schema keeps `param: 'response_format'`
 * (same marker as OpenAI) so M5-T5 can fall back.
 */
export class AnthropicAdapter implements AiProviderAdapter {
  async chat(
    config: AiProviderConfig,
    request: AiChatRequest,
  ): Promise<AiAdapterResult> {
    const { signal, ...rest } = request;
    const payload = anthropicMessagesBody(rest);
    try {
      const { status, body } = await postJson(
        'anthropic',
        anthropicMessagesUrl(config.baseUrl),
        {
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        payload,
        signal,
        [config.apiKey],
      );
      return parseAnthropicMessage(request.model, body, status);
    } catch (error) {
      throw request.responseFormat?.type === 'json_schema'
        ? markResponseFormatRefusal(error, SCHEMA_REFUSAL)
        : error;
    }
  }
}
