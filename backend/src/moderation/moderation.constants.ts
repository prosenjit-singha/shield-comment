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

/** Longest stored `reasoning` (D9), in code points (Postgres `char_length`). */
export const MAX_REASONING_CHARS = 280;

/**
 * Comment status (M5-T7). `PENDING` = stored, not moderated yet · `VISIBLE` = classified, nothing
 * to do (or the action was "none") · `NEEDS_REVIEW` = below the threshold (D4) or a review-mode
 * result · `HIDDEN` / `DELETED` = hidden / deleted on Meta by us (AI or a human) · `SKIPPED` = not
 * classified on purpose (`status_reason`, e.g. `credits_exhausted`) · `FAILED` = the AI or Meta
 * step failed for good (`status_reason` = error kind; the comment stays visible, D2).
 */
export const COMMENT_STATUSES = [
  'PENDING',
  'VISIBLE',
  'NEEDS_REVIEW',
  'HIDDEN',
  'DELETED',
  'SKIPPED',
  'FAILED',
] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/**
 * `comments.status_reason`, `moderation_actions.error_kind` and AI failure kinds are short machine
 * codes (never free text: no comment text or provider message can end up there).
 */
export const MACHINE_CODE_PATTERN = '^[a-z][a-z0-9_]{0,63}$';
const MACHINE_CODE = new RegExp(MACHINE_CODE_PATTERN);

export function isMachineCode(value: unknown): value is string {
  return typeof value === 'string' && MACHINE_CODE.test(value);
}

/** `comments.prompt_version` (e.g. `moderation-v2`). */
export const PROMPT_VERSION_PATTERN = '^[a-z0-9][a-z0-9._-]{0,49}$';

/**
 * Workspace moderation mode (D3/D5). `AUTO` (default, D3) = the policy's actions run on Meta;
 * `REVIEW` = classify only, never act: a result that would have acted becomes `NEEDS_REVIEW`.
 */
export const MODERATION_MODES = ['AUTO', 'REVIEW'] as const;
export type ModerationMode = (typeof MODERATION_MODES)[number];
export const DEFAULT_MODERATION_MODE: ModerationMode = 'AUTO';

/** What the policy does with a category at or above the threshold (D3/D5). */
export const POLICY_ACTIONS = ['NONE', 'HIDE', 'DELETE'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** D3: hide everything except `SAFE_INQUIRY`; delete is never a default. */
export const DEFAULT_CATEGORY_ACTIONS: Readonly<
  Record<ModerationCategory, PolicyAction>
> = {
  SAFE_INQUIRY: 'NONE',
  COMPETITOR_POACH: 'HIDE',
  SCAM_PHISHING: 'HIDE',
  SPAM_IRRELEVANT: 'HIDE',
  ABUSIVE_TOXIC: 'HIDE',
};

/** D4: one threshold per workspace, default 0.80 (stored `numeric(4,3)`, 0–1). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

/** D6: auto-reply texts (one en + one bn per category), 1–500 characters each. */
export const AUTO_REPLY_TEXT_MAX_CHARS = 500;

/** Meta actions the executor logs in `moderation_actions` (D10). */
export const MODERATION_ACTION_TYPES = [
  'HIDE',
  'UNHIDE',
  'DELETE',
  'REPLY',
] as const;
export type ModerationActionType = (typeof MODERATION_ACTION_TYPES)[number];

/** `AUTO` = the moderation worker (actor = system), `USER` = a workspace member (`user_id`). */
export const MODERATION_ACTION_SOURCES = ['AUTO', 'USER'] as const;
export type ModerationActionSource = (typeof MODERATION_ACTION_SOURCES)[number];

export const MODERATION_ACTION_STATES = [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
] as const;
export type ModerationActionState = (typeof MODERATION_ACTION_STATES)[number];

/** camelCase key per category: policy columns (`<key>Action`, …) and daily counters (`<key>Count`). */
export const MODERATION_CATEGORY_KEYS = {
  SAFE_INQUIRY: 'safeInquiry',
  COMPETITOR_POACH: 'competitorPoach',
  SCAM_PHISHING: 'scamPhishing',
  SPAM_IRRELEVANT: 'spamIrrelevant',
  ABUSIVE_TOXIC: 'abusiveToxic',
} as const satisfies Record<ModerationCategory, string>;
export type ModerationCategoryKey =
  (typeof MODERATION_CATEGORY_KEYS)[ModerationCategory];
