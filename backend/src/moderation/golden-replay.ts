import { createHash } from 'node:crypto';
import type { AiUsage, ChatMessage } from '../ai-gateway/ai-adapter.js';
import {
  type AiErrorKind,
  AiGatewayError,
} from '../ai-gateway/ai-gateway.errors.js';
import type {
  AiGatewayService,
  ChatOptions,
  ChatResult,
} from '../ai-gateway/ai-gateway.service.js';
import {
  type AiProvider,
  type AiProviderConfig,
  isAiProvider,
} from '../ai-gateway/ai-provider.js';
import { CommentClassifier } from './comment-classifier.js';
import { type GoldenComment, goldenClassifierInput } from './golden-fixture.js';
import type { GoldenOutcome } from './golden-score.js';
import { type ContextLevel, isContextLevel } from './moderation.constants.js';

/**
 * Golden-suite runner + replay (M5-T6, D12). A run classifies every fixture item through the real
 * `CommentClassifier`; every LLM call is captured so `--record` can write it to
 * `test/fixtures/golden-responses.<provider>.<model>.json`. CI replays those files with
 * `ReplayAiChat` (no network; a call the recording doesn't have throws).
 */

export const GOLDEN_REPLAY_FORMAT = 1;
/** `recorded` = real provider answers (`npm run ai:golden -- --record`); `hand-made` = written by hand. */
export const GOLDEN_REPLAY_SOURCES = ['recorded', 'hand-made'] as const;
export type GoldenReplaySource = (typeof GOLDEN_REPLAY_SOURCES)[number];

/** One captured LLM call: the answer, or the gateway error it raised. */
export type ReplayCall =
  | {
      content: string;
      model: string;
      usage?: AiUsage;
      finishReason?: string;
      latencyMs: number;
    }
  | {
      error: {
        kind: AiErrorKind;
        status: number | null;
        param?: string;
        message: string;
      };
      latencyMs: number;
    };

export interface ReplayItem {
  /** `goldenTextDigest(item.text)`: a recording of an edited comment fails instead of lying. */
  textSha256: string;
  /** Calls in the order the classifier made them (retries / fallbacks included). */
  calls: ReplayCall[];
}

export interface GoldenReplayFile {
  format: typeof GOLDEN_REPLAY_FORMAT;
  source: GoldenReplaySource;
  note?: string;
  provider: AiProvider;
  model: string;
  /** `PROMPT_VERSION` the answers were given for: another version fails loudly. */
  promptVersion: string;
  contextLevel: ContextLevel;
  recordedAt: string;
  /** Keyed by fixture item id. */
  items: Record<string, ReplayItem>;
}

export class GoldenReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenReplayError';
  }
}

/** `golden-responses.<provider>.<model>.json`; characters outside `[A-Za-z0-9._-]` → `_`. */
export function goldenReplayFileName(
  provider: AiProvider,
  model: string,
): string {
  return `golden-responses.${provider}.${model.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

export const GOLDEN_REPLAY_FILE_PATTERN = /^golden-responses\..+\.json$/;

/** First 16 hex chars of sha256(text): enough to notice an edited fixture comment. */
export function goldenTextDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsage(value: unknown): value is AiUsage {
  return (
    isRecord(value) &&
    typeof value.promptTokens === 'number' &&
    typeof value.completionTokens === 'number' &&
    typeof value.totalTokens === 'number'
  );
}

function isReplayCall(value: unknown): value is ReplayCall {
  if (!isRecord(value) || typeof value.latencyMs !== 'number') return false;
  if ('error' in value) {
    const error = value.error;
    return (
      isRecord(error) &&
      typeof error.kind === 'string' &&
      (error.status === null || typeof error.status === 'number') &&
      typeof error.message === 'string' &&
      (error.param === undefined || typeof error.param === 'string')
    );
  }
  return (
    typeof value.content === 'string' &&
    typeof value.model === 'string' &&
    (value.usage === undefined || isUsage(value.usage)) &&
    (value.finishReason === undefined || typeof value.finishReason === 'string')
  );
}

/**
 * Validates a replay file (parsed JSON). Throws `GoldenReplayError` on a bad shape or when it was
 * recorded for another prompt version (re-record it, or delete it, after a prompt change).
 */
export function parseGoldenReplay(
  value: unknown,
  expected: { promptVersion: string; name?: string },
): GoldenReplayFile {
  const name = expected.name ?? 'golden replay';
  const bad = (what: string) =>
    new GoldenReplayError(`${name}: invalid replay file (${what})`);
  if (!isRecord(value)) throw bad('not an object');
  if (value.format !== GOLDEN_REPLAY_FORMAT) throw bad('format');
  if (!(GOLDEN_REPLAY_SOURCES as readonly unknown[]).includes(value.source)) {
    throw bad('source');
  }
  if (!isAiProvider(value.provider)) throw bad('provider');
  if (typeof value.model !== 'string' || value.model.length === 0) {
    throw bad('model');
  }
  if (typeof value.promptVersion !== 'string') throw bad('promptVersion');
  if (!isContextLevel(value.contextLevel)) throw bad('contextLevel');
  if (typeof value.recordedAt !== 'string') throw bad('recordedAt');
  if (value.note !== undefined && typeof value.note !== 'string') {
    throw bad('note');
  }
  if (!isRecord(value.items)) throw bad('items');
  for (const [id, item] of Object.entries(value.items)) {
    if (
      !isRecord(item) ||
      typeof item.textSha256 !== 'string' ||
      !Array.isArray(item.calls) ||
      item.calls.length === 0 ||
      !item.calls.every(isReplayCall)
    ) {
      throw bad(`item ${id}`);
    }
  }
  if (value.promptVersion !== expected.promptVersion) {
    throw new GoldenReplayError(
      `${name} was recorded for prompt ${value.promptVersion}, but PROMPT_VERSION is ${expected.promptVersion}: re-record it (npm run ai:golden -- --record) or delete it`,
    );
  }
  return value as unknown as GoldenReplayFile;
}

/** The part of `AiGatewayService` the classifier uses. */
export type GoldenChat = Pick<AiGatewayService, 'chat'>;

/** Optional per-item hooks of a chat double (the replay uses them to pick the item's calls). */
export interface GoldenItemHooks {
  begin(item: GoldenComment): void;
  end(item: GoldenComment): void;
}

/**
 * Replays a recording as `AiGatewayService.chat`. `begin(item)` selects the item's calls (missing
 * or edited item → `GoldenReplayError`); every `chat` returns / throws the next call; a call the
 * recording doesn't have throws a plain `Error` (the classifier rethrows it); `end(item)` fails
 * when recorded calls were left over. No network.
 */
export class ReplayAiChat implements GoldenChat, GoldenItemHooks {
  private current: { id: string; calls: ReplayCall[]; used: number } | null =
    null;

  constructor(
    private readonly file: GoldenReplayFile,
    private readonly name = 'golden replay',
  ) {}

  begin(item: GoldenComment): void {
    const recorded = this.file.items[item.id];
    if (!recorded) {
      throw new GoldenReplayError(
        `${this.name} has no recording for ${item.id}: re-record it (npm run ai:golden -- --record)`,
      );
    }
    if (recorded.textSha256 !== goldenTextDigest(item.text)) {
      throw new GoldenReplayError(
        `${this.name}: the text of ${item.id} changed since it was recorded: re-record it`,
      );
    }
    this.current = { id: item.id, calls: recorded.calls, used: 0 };
  }

  end(item: GoldenComment): void {
    const current = this.current;
    this.current = null;
    if (
      current &&
      current.id === item.id &&
      current.used < current.calls.length
    ) {
      throw new GoldenReplayError(
        `${this.name}: ${item.id} made ${current.used} calls but ${current.calls.length} were recorded`,
      );
    }
  }

  chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResult> {
    const current = this.current;
    if (!current) {
      return Promise.reject(
        new Error(
          'Unexpected AiGatewayService.chat call outside a golden item',
        ),
      );
    }
    const call = current.calls[current.used];
    current.used += 1;
    if (!call) {
      return Promise.reject(
        new Error(
          `Unexpected AiGatewayService.chat call #${current.used} for ${current.id}: only ${current.calls.length} recorded`,
        ),
      );
    }
    if ('error' in call) {
      return Promise.reject(
        new AiGatewayError(call.error.kind, call.error.message, {
          status: call.error.status,
          provider: this.file.provider,
          ...(call.error.param !== undefined && { param: call.error.param }),
        }),
      );
    }
    return Promise.resolve({
      provider: this.file.provider,
      model: call.model,
      content: call.content,
      latencyMs: call.latencyMs,
      ...(call.usage && { usage: { ...call.usage } }),
      ...(call.finishReason !== undefined && {
        finishReason: call.finishReason,
      }),
    });
  }
}

/** Wraps a chat and keeps every call it makes (answers and `AiGatewayError`s) for the current item. */
class CapturingChat implements GoldenChat {
  private calls: ReplayCall[] = [];

  constructor(private readonly inner: GoldenChat) {}

  take(): ReplayCall[] {
    const calls = this.calls;
    this.calls = [];
    return calls;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const started = performance.now();
    try {
      const result = await this.inner.chat(messages, options);
      this.calls.push({
        content: result.content,
        model: result.model,
        latencyMs: result.latencyMs,
        ...(result.usage && { usage: { ...result.usage } }),
        ...(result.finishReason !== undefined && {
          finishReason: result.finishReason,
        }),
      });
      return result;
    } catch (error) {
      if (error instanceof AiGatewayError) {
        this.calls.push({
          error: {
            kind: error.kind,
            status: error.status,
            message: error.message,
            ...(error.param !== undefined && { param: error.param }),
          },
          latencyMs: Math.max(0, Math.round(performance.now() - started)),
        });
      }
      throw error;
    }
  }
}

function sumUsage(calls: readonly ReplayCall[]): AiUsage | undefined {
  let usage: AiUsage | undefined;
  for (const call of calls) {
    if ('error' in call || !call.usage) continue;
    usage = {
      promptTokens: (usage?.promptTokens ?? 0) + call.usage.promptTokens,
      completionTokens:
        (usage?.completionTokens ?? 0) + call.usage.completionTokens,
      totalTokens: (usage?.totalTokens ?? 0) + call.usage.totalTokens,
    };
  }
  return usage;
}

export interface GoldenRunOptions {
  chat: GoldenChat & Partial<GoldenItemHooks>;
  contextLevel: ContextLevel;
  /** Explicit provider config (script); omitted = the chat's own config (replay). */
  config?: AiProviderConfig;
  /** Stop at the first failure of these kinds (e.g. no key / no credits: every call would fail). */
  abortOn?: readonly string[];
  onItem?(outcome: GoldenOutcome, index: number): void;
}

export interface GoldenRunResult {
  outcomes: GoldenOutcome[];
  /** Captured calls per item id (input of `buildGoldenReplay`). */
  calls: Record<string, ReplayCall[]>;
  /** Set when `abortOn` stopped the run. */
  aborted?: { itemId: string; kind: string; status?: number | null };
}

/** Classifies the items one by one (sequential: easy on rate limits, deterministic replay). */
export async function runGoldenSuite(
  items: readonly GoldenComment[],
  options: GoldenRunOptions,
): Promise<GoldenRunResult> {
  const capture = new CapturingChat(options.chat);
  // The classifier only calls `chat`; the capture (and the replay behind it) implement exactly that.
  const classifier = new CommentClassifier(
    capture as unknown as AiGatewayService,
  );
  const outcomes: GoldenOutcome[] = [];
  const calls: Record<string, ReplayCall[]> = {};
  for (const [index, item] of items.entries()) {
    options.chat.begin?.(item);
    const result = await classifier.classify(
      goldenClassifierInput(item, options.contextLevel),
      options.config ? { config: options.config } : {},
    );
    options.chat.end?.(item);
    const itemCalls = capture.take();
    calls[item.id] = itemCalls;
    const usage = sumUsage(itemCalls);
    const outcome: GoldenOutcome = {
      item,
      result: result.ok
        ? {
            ok: true,
            category: result.category,
            confidence: result.confidence,
            outputMode: result.outputMode,
          }
        : { ok: false, kind: result.kind },
      latencyMs: itemCalls.reduce((sum, call) => sum + call.latencyMs, 0),
      attempts: result.attempts,
      ...(usage && { usage }),
    };
    outcomes.push(outcome);
    options.onItem?.(outcome, index);
    if (!result.ok && options.abortOn?.includes(result.kind)) {
      return {
        outcomes,
        calls,
        aborted: { itemId: item.id, kind: result.kind, status: result.status },
      };
    }
  }
  return { outcomes, calls };
}

/** The replay file for a finished run (fixture order; every item must have calls). */
export function buildGoldenReplay(input: {
  source: GoldenReplaySource;
  note?: string;
  provider: AiProvider;
  model: string;
  promptVersion: string;
  contextLevel: ContextLevel;
  recordedAt: Date;
  items: readonly GoldenComment[];
  calls: Record<string, ReplayCall[]>;
}): GoldenReplayFile {
  const items: Record<string, ReplayItem> = {};
  for (const item of input.items) {
    const calls = input.calls[item.id];
    if (!calls || calls.length === 0) {
      throw new GoldenReplayError(`no captured calls for ${item.id}`);
    }
    items[item.id] = { textSha256: goldenTextDigest(item.text), calls };
  }
  return {
    format: GOLDEN_REPLAY_FORMAT,
    source: input.source,
    ...(input.note !== undefined && { note: input.note }),
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion,
    contextLevel: input.contextLevel,
    recordedAt: input.recordedAt.toISOString(),
    items,
  };
}
