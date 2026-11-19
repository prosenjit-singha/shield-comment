import type { CommentPlatform } from '../db/schema/comments.js';
import {
  type ContextLevel,
  DEFAULT_CONTEXT_LEVEL,
  isContextLevel,
} from './moderation.constants.js';

/** Max characters (code points) of the comment and of the post caption sent to the LLM (D8). */
export const MAX_COMMENT_CHARS = 1_000;
export const MAX_CAPTION_CHARS = 1_000;
/** Page names are short on Meta; a longer value is cut so it can't smuggle a second caption in. */
export const MAX_PAGE_NAME_CHARS = 200;

/**
 * One classification request. Deliberately has no author name/id field (D8): the classifier
 * only ever reads the keys below, so extra keys on the object are ignored.
 */
export interface ClassifierInput {
  text: string;
  platform: CommentPlatform;
  /** The comment answers another comment (Meta `parent_id`). */
  isReply: boolean;
  /** The workspace's D8 setting; the level actually sent can be lower (missing data). */
  contextLevel: ContextLevel;
  pageName?: string | null;
  postCaption?: string | null;
}

/** What is actually sent: only the fields of the effective level. */
export interface NormalizedClassifierInput {
  text: string;
  platform: CommentPlatform;
  isReply: boolean;
  /** Level of the data sent: `post_caption` without a caption → `page_name` / `comment_only`. */
  contextLevel: ContextLevel;
  pageName?: string;
  postCaption?: string;
}

/** NFC, trim, every whitespace run (newlines, tabs, NBSP) → one space, cap in code points. */
export function normalizeText(value: string, maxChars: number): string {
  const collapsed = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(collapsed);
  return chars.length > maxChars
    ? chars.slice(0, maxChars).join('').trimEnd()
    : collapsed;
}

function optionalText(
  value: string | null | undefined,
  maxChars: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = normalizeText(value, maxChars);
  return text.length > 0 ? text : undefined;
}

/**
 * Pure normalisation (D8): returns `null` when the comment has no text left (the classifier
 * answers `empty_text` without a call). A level that asks for data we don't have drops to the
 * level of what is sent (the level stored on the comment is the one actually sent).
 */
export function normalizeClassifierInput(
  input: ClassifierInput,
): NormalizedClassifierInput | null {
  const text =
    typeof input.text === 'string'
      ? normalizeText(input.text, MAX_COMMENT_CHARS)
      : '';
  if (text.length === 0) return null;
  const requested = isContextLevel(input.contextLevel)
    ? input.contextLevel
    : DEFAULT_CONTEXT_LEVEL;
  const base = {
    text,
    platform: input.platform,
    isReply: input.isReply === true,
  };
  const pageName =
    requested === 'comment_only'
      ? undefined
      : optionalText(input.pageName, MAX_PAGE_NAME_CHARS);
  const postCaption =
    requested === 'post_caption'
      ? optionalText(input.postCaption, MAX_CAPTION_CHARS)
      : undefined;
  if (postCaption !== undefined) {
    return {
      ...base,
      contextLevel: 'post_caption',
      ...(pageName !== undefined && { pageName }),
      postCaption,
    };
  }
  if (pageName !== undefined) {
    return { ...base, contextLevel: 'page_name', pageName };
  }
  return { ...base, contextLevel: 'comment_only' };
}
