import {
  type CommentLanguage,
  isModerationCategory,
  type ModerationCategory,
} from './moderation.constants.js';
import { MAX_REASONING_CHARS } from './moderation-prompt.js';

export interface ClassificationOutput {
  category: ModerationCategory;
  /** 0–1, rounded to 3 decimals (fits `numeric(4,3)`). */
  confidence: number;
  /** Whitespace collapsed, ≤ `MAX_REASONING_CHARS` code points (D9). */
  reasoning: string;
  language: CommentLanguage;
}

/** Why an answer was rejected. Safe to log (never contains the answer itself). */
export type OutputRejection =
  | 'not_json'
  | 'not_object'
  | 'category'
  | 'confidence'
  | 'reasoning'
  | 'language';

export type ParsedOutput =
  | { ok: true; value: ClassificationOutput }
  | { ok: false; rejection: OutputRejection };

/** Floating-point slack: a value just outside 0–1 is clamped; anything further is rejected. */
const CONFIDENCE_SLACK = 0.05;

const LANGUAGE_ALIASES: ReadonlyMap<string, CommentLanguage> = new Map([
  ['bn', 'bn'],
  ['bangla', 'bn'],
  ['bengali', 'bn'],
  ['bn-bd', 'bn'],
  ['banglish', 'banglish'],
  ['bn-latn', 'banglish'],
  ['en', 'en'],
  ['english', 'en'],
]);

/** Strips a Markdown code fence and any prose around the outermost `{…}`. */
export function extractJsonText(content: string): string {
  let text = content.trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/u.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function readConfidence(raw: Record<string, unknown>): number | null {
  const value = raw.confidence_score ?? raw.confidence;
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(num)) return null;
  if (num < -CONFIDENCE_SLACK || num > 1 + CONFIDENCE_SLACK) return null;
  return Math.round(Math.min(1, Math.max(0, num)) * 1000) / 1000;
}

export function truncateReasoning(value: string): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > MAX_REASONING_CHARS
    ? `${chars
        .slice(0, MAX_REASONING_CHARS - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

/**
 * Validates one LLM answer: category enum (case-insensitive), `confidence_score` or `confidence`
 * (number or numeric string, clamped within 0.05 of 0–1, else rejected), reasoning string
 * (≤ 280, cut with "…"), language enum (+ a few aliases). Unknown keys are dropped.
 */
export function parseClassificationOutput(content: string): ParsedOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonText(content));
  } catch {
    return { ok: false, rejection: 'not_json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, rejection: 'not_object' };
  }
  const record = raw as Record<string, unknown>;
  const category =
    typeof record.category === 'string'
      ? record.category.trim().toUpperCase()
      : undefined;
  if (!isModerationCategory(category)) {
    return { ok: false, rejection: 'category' };
  }
  const confidence = readConfidence(record);
  if (confidence === null) return { ok: false, rejection: 'confidence' };
  if (typeof record.reasoning !== 'string') {
    return { ok: false, rejection: 'reasoning' };
  }
  const language =
    typeof record.language === 'string'
      ? LANGUAGE_ALIASES.get(record.language.trim().toLowerCase())
      : undefined;
  if (language === undefined) return { ok: false, rejection: 'language' };
  return {
    ok: true,
    value: {
      category,
      confidence,
      reasoning: truncateReasoning(record.reasoning),
      language,
    },
  };
}
