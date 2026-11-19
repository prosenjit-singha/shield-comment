import { COMMENT_PLATFORMS } from '../db/schema/comments.js';
import type { CommentPlatform } from '../db/schema/comments.js';
import type { ClassifierInput } from './classifier-input.js';
import { MAX_COMMENT_CHARS } from './classifier-input.js';
import {
  COMMENT_LANGUAGES,
  type CommentLanguage,
  type ContextLevel,
  isModerationCategory,
  MODERATION_CATEGORIES,
  type ModerationCategory,
} from './moderation.constants.js';

/**
 * Golden suite (M5-T6, D12): the labelled comments in `test/fixtures/golden-comments.ts`.
 * Pure: the fixture type, its invariants and how one item becomes a classifier input.
 */

export const GOLDEN_MIN_ITEMS = 40;
export const GOLDEN_MIN_PER_CATEGORY = 6;

/** One labelled comment. Made-up text, numbers and links (no real people, shops or phones). */
export interface GoldenComment {
  /** Stable id (`<category>-NN`): replay recordings are keyed by it. */
  id: string;
  text: string;
  platform: CommentPlatform;
  isReply: boolean;
  /** The label the classifier must answer (reviewed by the user, D12). */
  expected: ModerationCategory;
  /** Main language; code-mixed comments also carry the `mixed` tag. */
  language: CommentLanguage;
  /** Free-form slices for the report, e.g. `injection`, `bkash`, `mixed`, `wa.me`, `phone`. */
  tags: readonly string[];
  /** Sent only at the `page_name` / `post_caption` levels (D8). */
  pageName?: string;
  /** Sent only at the `post_caption` level (D8). */
  postCaption?: string;
  /** Why this label: a hint for the label review, never sent to the LLM. */
  note?: string;
}

const ID_PATTERN = /^[a-z]+-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * Checks the fixture shape + D12 invariants (≥ 40 items, ≥ 6 per category, unique ids, every
 * language, injection items, text ≤ 1,000 chars) and returns it typed. Throws one error listing
 * every problem. The script calls it on the dynamically imported fixture; the spec calls it too.
 */
export function validateGoldenFixture(value: unknown): GoldenComment[] {
  const problems: string[] = [];
  if (!Array.isArray(value)) {
    throw new Error('Golden fixture: expected an array of items');
  }
  const ids = new Set<string>();
  const items: GoldenComment[] = [];
  value.forEach((raw: unknown, index) => {
    const where = `item ${index}`;
    if (!isRecord(raw)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const id = typeof raw.id === 'string' ? raw.id : '';
    const label = id || where;
    if (!ID_PATTERN.test(id))
      problems.push(`${label}: id must match <word>-NN`);
    else if (ids.has(id)) problems.push(`${label}: duplicate id`);
    ids.add(id);
    if (typeof raw.text !== 'string' || raw.text.trim().length === 0) {
      problems.push(`${label}: empty text`);
    } else if (Array.from(raw.text).length > MAX_COMMENT_CHARS) {
      problems.push(`${label}: text longer than ${MAX_COMMENT_CHARS} chars`);
    }
    if (!(COMMENT_PLATFORMS as readonly unknown[]).includes(raw.platform)) {
      problems.push(`${label}: platform`);
    }
    if (typeof raw.isReply !== 'boolean') problems.push(`${label}: isReply`);
    if (!isModerationCategory(raw.expected))
      problems.push(`${label}: expected`);
    if (!(COMMENT_LANGUAGES as readonly unknown[]).includes(raw.language)) {
      problems.push(`${label}: language`);
    }
    if (
      !Array.isArray(raw.tags) ||
      !raw.tags.every((t: unknown) => typeof t === 'string' && t.length > 0)
    ) {
      problems.push(`${label}: tags`);
    }
    if (
      !optionalString(raw.pageName) ||
      !optionalString(raw.postCaption) ||
      !optionalString(raw.note)
    ) {
      problems.push(`${label}: pageName / postCaption / note must be strings`);
    }
    items.push(raw as unknown as GoldenComment);
  });

  if (problems.length === 0) {
    if (items.length < GOLDEN_MIN_ITEMS) {
      problems.push(`only ${items.length} items (need ≥ ${GOLDEN_MIN_ITEMS})`);
    }
    for (const category of MODERATION_CATEGORIES) {
      const count = items.filter((i) => i.expected === category).length;
      if (count < GOLDEN_MIN_PER_CATEGORY) {
        problems.push(
          `${category}: ${count} items (need ≥ ${GOLDEN_MIN_PER_CATEGORY})`,
        );
      }
    }
    for (const language of COMMENT_LANGUAGES) {
      if (!items.some((i) => i.language === language)) {
        problems.push(`no ${language} item`);
      }
    }
    if (!items.some((i) => i.tags.includes('mixed'))) {
      problems.push('no mixed-language item (tag "mixed")');
    }
    if (!items.some((i) => i.tags.includes('injection'))) {
      problems.push('no prompt-injection item (tag "injection")');
    }
  }
  if (problems.length > 0) {
    throw new Error(`Golden fixture is invalid:\n- ${problems.join('\n- ')}`);
  }
  return items;
}

/** The classifier input for `item` at the run's context level (D8: only the level's fields). */
export function goldenClassifierInput(
  item: GoldenComment,
  contextLevel: ContextLevel,
): ClassifierInput {
  return {
    text: item.text,
    platform: item.platform,
    isReply: item.isReply,
    contextLevel,
    ...(item.pageName !== undefined && { pageName: item.pageName }),
    ...(item.postCaption !== undefined && { postCaption: item.postCaption }),
  };
}
