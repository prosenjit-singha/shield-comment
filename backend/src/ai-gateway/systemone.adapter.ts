import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  TypeSafeClient,
  TypeSafeError,
} from '@typesafe-ai/sdk';
import type { AiUsage } from './ai-adapter.js';
import {
  AiGatewayError,
  aiErrorFromResponse,
  redactAiSecrets,
} from './ai-gateway.errors.js';
import type { AiProviderConfig } from './ai-provider.js';

/**
 * Neon AI Gateway `systemone` dialect (M5-T15a, D24): TypeSafe System One decision models (Jev)
 * answer typed questions about a `state` with probabilities instead of generating text. Served
 * only at `POST <gateway>/typesafe/v1/systemone` (no chat completions, no streaming). Calls go
 * through the official `@typesafe-ai/sdk` (`baseURL` = `<gateway>/typesafe`, the Neon gateway
 * token as `apiKey`), with SDK retries, logging and zstd compression off; SDK errors map onto
 * the shared `AiErrorKind`s (`aiErrorFromResponse`), like the chat adapters.
 * Only `noul` (yes/no) questions so far; add `choice` / `score` when a question needs them.
 */

/** Neon gateway model ids served on the systemone dialect (`GET /v1/models` → `dialects: ["systemone"]`). */
const SYSTEMONE_MODEL = /^(typesafeai-jev-|openjev-)/;

export function isSystemOneModel(model: string): boolean {
  return SYSTEMONE_MODEL.test(model);
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  /** What a yes and a no mean (optional; aligned with `instructions`). */
  criteria?: { true: string; false: string };
}

export interface SystemOneRequest {
  model: string;
  /** Text or a JSON object with named fields that questions refer to as `field` in backticks. */
  state: string | Record<string, string>;
  questions: Record<string, NoulQuestion>;
  /** Per-call timeout (the SDK aborts and throws `APITimeoutError` → `timeout`). */
  timeoutMs: number;
}

export interface SystemOneResult {
  /** Model that served the request (e.g. `jev-1.14.0`), else the requested id. */
  model: string;
  /** Question id → probability of a yes (0–1). */
  nouls: Record<string, number>;
  usage?: AiUsage;
}

/** SDK base URL `<base>/typesafe` (the SDK adds `/v1/systemone`); a trailing `/v1` on the Neon base is dropped. */
export function systemOneBaseUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/typesafe`;
}

/** SDK failure → `AiGatewayError` (status/body kinds as the chat adapters; messages scrubbed). */
export function systemOneError(
  error: unknown,
  secrets: readonly string[],
): AiGatewayError | undefined {
  if (error instanceof APIError) {
    return aiErrorFromResponse(
      'neon',
      error.status,
      error.body,
      error.headers,
      secrets,
    );
  }
  if (error instanceof APITimeoutError) {
    return new AiGatewayError('timeout', 'AI neon request timed out', {
      provider: 'neon',
    });
  }
  if (error instanceof APIConnectionError) {
    return new AiGatewayError('network', 'AI neon request failed (network)', {
      provider: 'neon',
    });
  }
  if (error instanceof TypeSafeError) {
    // Rejected by the SDK before sending (e.g. empty questions).
    return new AiGatewayError(
      'invalid_request',
      `AI neon systemone request rejected: ${redactAiSecrets(error.message, secrets).slice(0, 300)}`,
      { provider: 'neon' },
    );
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** 2xx body → result. A missing / malformed answer for any asked question → `unexpected_response`. */
export function parseSystemOneResponse(
  requestedModel: string,
  questionIds: readonly string[],
  body: unknown,
  status = 200,
): SystemOneResult {
  const unexpected = (what: string) =>
    new AiGatewayError(
      'unexpected_response',
      `AI neon ${status}: ${what} (systemone)`,
      { status, provider: 'neon' },
    );
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw unexpected('no answers in the response');
  }
  const nouls: Record<string, number> = {};
  for (const id of questionIds) {
    const answer = body.answers[id];
    const p = isRecord(answer) ? answer.noul : undefined;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw unexpected(`no noul answer for "${id}"`);
    }
    nouls[id] = p;
  }
  const usage = isRecord(body.usage) ? body.usage : undefined;
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  return {
    model:
      typeof body.model === 'string' && body.model
        ? body.model
        : requestedModel,
    nouls,
    ...(usage && {
      usage: {
        promptTokens: input,
        completionTokens: output,
        totalTokens: input + output,
      },
    }),
  };
}

export class SystemOneAdapter {
  async decide(
    config: AiProviderConfig,
    request: SystemOneRequest,
  ): Promise<SystemOneResult> {
    if (config.provider !== 'neon') {
      throw new AiGatewayError(
        'not_configured',
        `systemone models are served only by the Neon AI gateway (provider ${config.provider})`,
        { provider: config.provider },
      );
    }
    const client = new TypeSafeClient({
      apiKey: config.apiKey,
      baseURL: systemOneBaseUrl(config.baseUrl),
      defaultModel: request.model,
      retry: { maxRetries: 0 },
      logLevel: 'off',
      compression: false,
    });
    let result: unknown;
    try {
      result = await client.systemOne(
        { state: request.state, questions: request.questions },
        { timeout: request.timeoutMs },
      );
    } catch (error) {
      throw systemOneError(error, [config.apiKey]) ?? error;
    }
    return parseSystemOneResponse(
      request.model,
      Object.keys(request.questions),
      result,
    );
  }
}
