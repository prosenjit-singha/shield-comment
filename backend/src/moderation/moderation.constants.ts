/**
 * Moderation vocabulary (Module 5). Pure constants: no Nest imports, so schema files (M5-T7),
 * DTOs and scripts can import them without pulling in the AI client.
 */

/** Classifier categories (spec § "Backend Implementation"). Order = prompt + report order. */
export const MODERATION_CATEGORIES = [
  'SAFE_INQUIRY',
  'COMPETITOR_POACH',
  'SCAM_PHISHING',
  'SPAM_IRRELEVANT',
  'ABUSIVE_TOXIC',
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

export function isModerationCategory(
  value: unknown,
): value is ModerationCategory {
  return (
    typeof value === 'string' &&
    (MODERATION_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Comment language (D6): `bn` = Bangla script, `banglish` = Bangla in Latin letters, `en` = English. */
export const COMMENT_LANGUAGES = ['bn', 'banglish', 'en'] as const;
export type CommentLanguage = (typeof COMMENT_LANGUAGES)[number];

/**
 * What the LLM sees per workspace (D8): `comment_only` = comment + platform + is-a-reply,
 * `page_name` = + the Page name, `post_caption` = + the Page name and the post caption.
 * Never the author name or id.
 */
export const CONTEXT_LEVELS = [
  'comment_only',
  'page_name',
  'post_caption',
] as const;
export type ContextLevel = (typeof CONTEXT_LEVELS)[number];

export const DEFAULT_CONTEXT_LEVEL: ContextLevel = 'comment_only';

export function isContextLevel(value: unknown): value is ContextLevel {
  return (
    typeof value === 'string' &&
    (CONTEXT_LEVELS as readonly string[]).includes(value)
  );
}

/** AI credits per classification call by the level actually sent (D8 + D15). */
export const CONTEXT_LEVEL_CREDITS: Readonly<Record<ContextLevel, number>> = {
  comment_only: 1,
  page_name: 1,
  post_caption: 2,
};

/** Credits one call costs at `level` (use the *effective* level: see `normalizeClassifierInput`). */
export function creditCostForLevel(level: ContextLevel): number {
  return CONTEXT_LEVEL_CREDITS[level];
}
