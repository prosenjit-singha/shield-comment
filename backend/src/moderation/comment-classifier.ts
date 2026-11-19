import { Injectable, Logger } from '@nestjs/common';
import type { AiUsage } from '../ai-gateway/ai-adapter.js';
import {
  type AiErrorKind,
  AiGatewayError,
  isRetryableAiErrorKind,
} from '../ai-gateway/ai-gateway.errors.js';
import {
  AiGatewayService,
  type ChatResult,
  MODERATION_TIMEOUT_MS,
} from '../ai-gateway/ai-gateway.service.js';
import type {
  AiProvider,
  AiProviderConfig,
} from '../ai-gateway/ai-provider.js';
import {
  type ClassifierInput,
  normalizeClassifierInput,
} from './classifier-input.js';
import {
  type ClassificationOutput,
  type OutputRejection,
  parseClassificationOutput,
} from './classifier-output.js';
import {
  type ContextLevel,
  creditCostForLevel,
} from './moderation.constants.js';
import {
  buildClassifierMessages,
  CLASSIFIER_OUTPUT_MODES,
  type ClassifierOutputMode,
  PROMPT_VERSION,
  responseFormatFor,
} from './moderation-prompt.js';

/** Output tokens per call: room for reasoning models' hidden tokens + the small JSON answer. */
export const CLASSIFIER_MAX_TOKENS = 1_024;
/** Calls that may return unusable output (invalid JSON / schema, empty reply) before giving up (D2). */
export const CLASSIFIER_MAX_OUTPUT_ATTEMPTS = 2;

export interface ClassificationSuccess extends ClassificationOutput {
  ok: true;
  /** Level of the data actually sent (drives the credit cost, D8/D15). */
  contextLevel: ContextLevel;
  credits: number;
  promptVersion: string;
  provider: AiProvider;
  model: string;
  /** Output mode that produced the answer (after any `response_format` fallback). */
  outputMode: ClassifierOutputMode;
  /** Summed over every call of this classification (retries included). */
  usage?: AiUsage;
  /** Wall time of the whole classification, ms. */
  latencyMs: number;
  /** LLM calls made (1 = first answer was valid). */
  attempts: number;
}

export type ClassificationFailureKind =
  AiErrorKind | 'invalid_output' | 'empty_text';

export interface ClassificationFailure {
  ok: false;
  kind: ClassificationFailureKind;
  /** Worth a BullMQ retry (D2): only the transient AI kinds. */
  retryable: boolean;
  promptVersion: string;
  /** LLM calls made (0 for `empty_text`). */
  attempts: number;
  latencyMs: number;
  provider?: AiProvider;
  model?: string;
  /** HTTP status of the last provider error, when there was one. */
  status?: number | null;
  /** Provider `Retry-After` (≤ 5 min) on `rate_limited`. */
  retryAfterMs?: number;
  /** `invalid_output`: why the last answer was rejected. */
  rejection?: OutputRejection;
  /** Tokens spent by calls that did answer (an invalid answer still costs tokens). */
  usage?: AiUsage;
}

export type ClassificationResult =
  ClassificationSuccess | ClassificationFailure;

export interface ClassifyOptions {
  /** Explicit provider config instead of the resolver (M5-T6 golden-suite script). */
  config?: AiProviderConfig;
}

function addUsage(
  total: AiUsage | undefined,
  usage: AiUsage | undefined,
): AiUsage | undefined {
  if (!usage) return total;
  if (!total) return { ...usage };
  return {
    promptTokens: total.promptTokens + usage.promptTokens,
    completionTokens: total.completionTokens + usage.completionTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
  };
}

/** A provider refused the structured-output parameter: try the next, weaker output mode. */
function isResponseFormatRefusal(error: AiGatewayError): boolean {
  return error.kind === 'invalid_request' && error.param === 'response_format';
}

/**
 * Classifies one comment (M5-T5). Pure: no DB, no Graph, no credits (callers reserve
 * `credits` first via `classificationCreditCost`). Expected failures come back as
 * `{ ok: false, kind, retryable }`; only non-AI errors (e.g. the config resolver's DB) throw.
 *
 * Output: `json_schema` (strict) → on a `response_format` refusal `json_object` → prompt-only
 * JSON, per call (nothing remembered). An unusable answer (bad JSON / schema / empty reply) gets
 * one more call, then `invalid_output`. Temperature 0. Logs provider / model / kind / ms /
 * tokens / attempts only: never the comment, caption, Page name, prompt or reply.
 */
@Injectable()
export class CommentClassifier {
  private readonly logger = new Logger(CommentClassifier.name);

  constructor(private readonly ai: AiGatewayService) {}

  async classify(
    input: ClassifierInput,
    options: ClassifyOptions = {},
  ): Promise<ClassificationResult> {
    const started = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    const normalized = normalizeClassifierInput(input);
    if (!normalized) {
      return {
        ok: false,
        kind: 'empty_text',
        retryable: false,
        promptVersion: PROMPT_VERSION,
        attempts: 0,
        latencyMs: elapsed(),
      };
    }
    const messages = buildClassifierMessages(normalized);
    let modeIndex = 0;
    let attempts = 0;
    let outputFailures = 0;
    let usage: AiUsage | undefined;
    let last: { provider?: AiProvider; model?: string } = {};
    let lastFailure: {
      kind: 'invalid_output' | 'unexpected_response';
      rejection?: OutputRejection;
      status?: number | null;
    } = { kind: 'invalid_output' };

    while (outputFailures < CLASSIFIER_MAX_OUTPUT_ATTEMPTS) {
      const mode = CLASSIFIER_OUTPUT_MODES[modeIndex] ?? 'prompt';
      attempts += 1;
      let reply: ChatResult;
      try {
        reply = await this.ai.chat(messages, {
          temperature: 0,
          maxTokens: CLASSIFIER_MAX_TOKENS,
          timeoutMs: MODERATION_TIMEOUT_MS,
          responseFormat: responseFormatFor(mode),
          ...(options.config && { config: options.config }),
        });
      } catch (error) {
        if (!(error instanceof AiGatewayError)) throw error;
        last = {
          provider: error.provider ?? last.provider,
          model: last.model,
        };
        if (
          isResponseFormatRefusal(error) &&
          modeIndex < CLASSIFIER_OUTPUT_MODES.length - 1
        ) {
          modeIndex += 1;
          this.logger.log(
            `classify fallback provider=${error.provider ?? '-'} from=${mode} to=${CLASSIFIER_OUTPUT_MODES[modeIndex]}`,
          );
          continue;
        }
        if (error.kind === 'unexpected_response') {
          outputFailures += 1;
          lastFailure = { kind: 'unexpected_response', status: error.status };
          continue;
        }
        return this.fail(
          {
            ok: false,
            kind: error.kind,
            retryable: isRetryableAiErrorKind(error.kind),
            promptVersion: PROMPT_VERSION,
            attempts,
            latencyMs: elapsed(),
            ...last,
            status: error.status,
            ...(error.retryAfterMs !== undefined && {
              retryAfterMs: error.retryAfterMs,
            }),
            ...(usage && { usage }),
          },
          mode,
        );
      }
      usage = addUsage(usage, reply.usage);
      last = { provider: reply.provider, model: reply.model };
      const parsed = parseClassificationOutput(reply.content);
      if (parsed.ok) {
        const result: ClassificationSuccess = {
          ok: true,
          ...parsed.value,
          contextLevel: normalized.contextLevel,
          credits: creditCostForLevel(normalized.contextLevel),
          promptVersion: PROMPT_VERSION,
          provider: reply.provider,
          model: reply.model,
          outputMode: mode,
          ...(usage && { usage }),
          latencyMs: elapsed(),
          attempts,
        };
        this.logger.log(
          `classify ok provider=${result.provider} model=${result.model} mode=${mode} attempts=${attempts} ms=${result.latencyMs} tokens=${usage?.promptTokens ?? '?'}/${usage?.completionTokens ?? '?'}`,
        );
        return result;
      }
      outputFailures += 1;
      lastFailure = { kind: 'invalid_output', rejection: parsed.rejection };
    }

    const kind = lastFailure.kind;
    return this.fail(
      {
        ok: false,
        kind,
        retryable: false,
        promptVersion: PROMPT_VERSION,
        attempts,
        latencyMs: elapsed(),
        ...last,
        ...(lastFailure.rejection && { rejection: lastFailure.rejection }),
        ...(lastFailure.status !== undefined && { status: lastFailure.status }),
        ...(usage && { usage }),
      },
      CLASSIFIER_OUTPUT_MODES[modeIndex] ?? 'prompt',
    );
  }

  private fail(
    failure: ClassificationFailure,
    mode: ClassifierOutputMode,
  ): ClassificationFailure {
    this.logger.warn(
      `classify failed provider=${failure.provider ?? '-'} model=${failure.model ?? '-'} kind=${failure.kind}${failure.rejection ? ` rejection=${failure.rejection}` : ''} mode=${mode} attempts=${failure.attempts} ms=${failure.latencyMs} tokens=${failure.usage?.promptTokens ?? '?'}/${failure.usage?.completionTokens ?? '?'}`,
    );
    return failure;
  }
}
