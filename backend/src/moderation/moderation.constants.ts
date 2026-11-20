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

/** Longest cached post caption (`post_contexts.caption`, M5-T10), in code points. */
export const MAX_STORED_CAPTION_CHARS = 2_000;
/** A cached caption older than this is fetched again from Graph (M5-T10, D8). */
export const POST_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

/** Longest stored `reasoning` (D9), in code points (Postgres `char_length`). */
export const MAX_REASONING_CHARS = 280;

/**
 * Comment status (M5-T7). `PENDING` = stored, not moderated yet · `VISIBLE` = classified, nothing
 * to do (or the action was "none") · `NEEDS_REVIEW` = below the threshold (D4) or a review-mode
 * result · `HIDDEN` / `DELETED` = hidden / deleted on Meta by us (AI or a human) · `SKIPPED` = not
 * classified on purpose (`status_reason`, e.g. `comment_limit_reached`) · `FAILED` = the AI or Meta
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
 * `comments.moderation_stage` (M5-T12): what the worker still owes the current text. `classify` =
 * not classified yet (new comment or applied edit); `act` = classified, the Meta action / reply is
 * not finished. `null` = done.
 */
export const MODERATION_STAGES = ['classify', 'act'] as const;
export type ModerationStage = (typeof MODERATION_STAGES)[number];

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

/**
 * Static rules (Module 6, decisions 2026-11-20 D2/D4/D5/D6). Rule kinds in match order; each kind
 * has its own action (D2 b, default `HIDE`). A match sets `status_reason` `rule_<kind>` and keeps
 * the matched value in `comments.rule_match`.
 */
export const RULE_KINDS = ['keyword', 'url', 'phone'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const RULE_ACTIONS = ['HIDE', 'DELETE'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
export const DEFAULT_RULE_ACTION: RuleAction = 'HIDE';

/** `comments.status_reason` of a rule match (`rule_keyword`, `rule_url`, `rule_phone`). */
export const RULE_STATUS_REASONS = {
  keyword: 'rule_keyword',
  url: 'rule_url',
  phone: 'rule_phone',
} as const satisfies Record<RuleKind, string>;

/** D5: at most 200 blocked keywords per workspace, 1–50 characters (code points) each. */
export const MAX_BLOCKED_KEYWORDS = 200;
export const MAX_KEYWORD_CHARS = 50;
/** D6 own-domain allow-list of the URL rule. */
export const MAX_ALLOWED_DOMAINS = 20;
export const MAX_DOMAIN_CHARS = 253;
/** Longest `comments.rule_match` (a matched URL is cut to this). */
export const MAX_RULE_MATCH_CHARS = 200;
