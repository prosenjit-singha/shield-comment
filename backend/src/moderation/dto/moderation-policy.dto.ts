import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  AUTO_REPLY_TEXT_MAX_CHARS,
  CONTEXT_LEVELS,
  type ContextLevel,
  MODERATION_MODES,
  type ModerationCategory,
  type ModerationMode,
  POLICY_ACTIONS,
  type PolicyAction,
  RULE_ACTIONS,
  type RuleAction,
} from '../moderation.constants.js';
import type { CategoryRule, StaticRules } from '../moderation.queries.js';

/**
 * Workspace moderation policy API (M5-T8, D5 answered 2026-11-19):
 * `GET/PATCH /api/workspaces/:workspaceId/moderation/policy` (owner/admin; impersonated ok).
 *
 * - `GET` → `ModerationPolicyResponse` (the row is created with the D3/D4/D6/D8 defaults on first
 *   read).
 * - `PATCH` (partial, see `UpdateModerationPolicyDto`) → `ModerationPolicyUpdateResponse`.
 *   400 invalid body / nothing to update / an auto-reply switched on without both texts
 *   (`code: AUTO_REPLY_TEXTS_REQUIRED`, `details { category }`); 409
 *   `code: PLAN_FEATURE_UNAVAILABLE` (`details { feature: 'autoReplyTemplates' }`) when the body
 *   sends `autoReply: true` on a plan without auto-reply templates (no plan = Free plan).
 *
 * Static rules (M6-T1; D2/D4/D5/D6 answered 2026-11-20): `rules` in both. `blockedKeywords` /
 * `allowedDomains` replace the whole list; entries are normalised and de-duplicated. 400 codes:
 * `BLOCKED_KEYWORD_INVALID` (`details { keyword }`, blank or > 50 chars), `BLOCKED_KEYWORDS_LIMIT`
 * / `ALLOWED_DOMAINS_LIMIT` (`details { max }`), `ALLOWED_DOMAIN_INVALID` (`details { domain }`).
 * 409 `PLAN_FEATURE_UNAVAILABLE` when the body adds a keyword without `customBlocklist`
 * (`details { feature: 'customBlocklist' }`) or switches the URL / phone rule on without
 * `autoHideScams` (D4). Removing keywords, switching off, domains and actions are never gated.
 */

/** D4 threshold range the API accepts (the DB allows 0–1): below 0.5 the AI would act on guesses. */
export const MIN_CONFIDENCE_THRESHOLD = 0.5;
export const MAX_CONFIDENCE_THRESHOLD = 1;

export const MODERATION_POLICY_ERROR_CODES = {
  /** 409: the plan has no `autoReplyTemplates` (D6); `details { feature }`. */
  planFeatureUnavailable: 'PLAN_FEATURE_UNAVAILABLE',
  /** 400: an auto-reply would be on without both an en and a bn text; `details { category }`. */
  autoReplyTextsRequired: 'AUTO_REPLY_TEXTS_REQUIRED',
  /** 400: a keyword is blank or longer than 50 chars once normalised; `details { keyword }`. */
  blockedKeywordInvalid: 'BLOCKED_KEYWORD_INVALID',
  /** 400: more than 200 distinct keywords; `details { max }`. */
  blockedKeywordsLimit: 'BLOCKED_KEYWORDS_LIMIT',
  /** 400: an allow-list entry is not a domain name; `details { domain }`. */
  allowedDomainInvalid: 'ALLOWED_DOMAIN_INVALID',
  /** 400: more than 20 distinct domains; `details { max }`. */
  allowedDomainsLimit: 'ALLOWED_DOMAINS_LIMIT',
} as const;

/** Policy as the API returns it (flat; `categories` keyed by category). */
export interface ModerationPolicyResponse {
  workspaceId: string;
  mode: ModerationMode;
  confidenceThreshold: number;
  aiContextLevel: ContextLevel;
  categories: Record<ModerationCategory, CategoryRule>;
  /** The workspace's plan has `autoReplyTemplates` (D6): the UI enables the auto-reply switches. */
  autoReplyAvailable: boolean;
  /** Static rules (M6-T1). */
  rules: StaticRules;
  /** Plan has `customBlocklist` (D4): keywords may be added. */
  keywordRulesAvailable: boolean;
  /** Plan has `autoHideScams` (D4, every live plan): the URL / phone rules may be switched on. */
  urlPhoneRulesAvailable: boolean;
  updatedAt: Date;
}

export interface ModerationPolicyUpdateResponse extends ModerationPolicyResponse {
  /** `false` = the body matched the stored policy: nothing written, `updatedAt` kept. */
  changed: boolean;
}

/** Present-but-`null` fails the validators that follow (only "absent" skips them). */
const unlessAbsent = <T extends object>(key: keyof T) =>
  ValidateIf((o: T) => o[key] !== undefined);

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** One category's changes. Texts are trimmed, 1–500 chars; `null` clears a text. */
export class CategoryRulePatchDto {
  @unlessAbsent<CategoryRulePatchDto>('action')
  @IsIn(POLICY_ACTIONS)
  action?: PolicyAction;

  @unlessAbsent<CategoryRulePatchDto>('autoReply')
  @IsBoolean()
  autoReply?: boolean;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(AUTO_REPLY_TEXT_MAX_CHARS)
  replyEn?: string | null;

  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(AUTO_REPLY_TEXT_MAX_CHARS)
  replyBn?: string | null;
}

/** Per-category changes; an unknown category key → 400. */
export class CategoriesPatchDto {
  @unlessAbsent<CategoriesPatchDto>('SAFE_INQUIRY')
  @IsObject()
  @ValidateNested()
  @Type(() => CategoryRulePatchDto)
  SAFE_INQUIRY?: CategoryRulePatchDto;

  @unlessAbsent<CategoriesPatchDto>('COMPETITOR_POACH')
  @IsObject()
  @ValidateNested()
  @Type(() => CategoryRulePatchDto)
  COMPETITOR_POACH?: CategoryRulePatchDto;

  @unlessAbsent<CategoriesPatchDto>('SCAM_PHISHING')
  @IsObject()
  @ValidateNested()
  @Type(() => CategoryRulePatchDto)
  SCAM_PHISHING?: CategoryRulePatchDto;

  @unlessAbsent<CategoriesPatchDto>('SPAM_IRRELEVANT')
  @IsObject()
  @ValidateNested()
  @Type(() => CategoryRulePatchDto)
  SPAM_IRRELEVANT?: CategoryRulePatchDto;

  @unlessAbsent<CategoriesPatchDto>('ABUSIVE_TOXIC')
  @IsObject()
  @ValidateNested()
  @Type(() => CategoryRulePatchDto)
  ABUSIVE_TOXIC?: CategoryRulePatchDto;
}

/** Action per rule kind (D2 b). */
export class RuleActionsPatchDto {
  @unlessAbsent<RuleActionsPatchDto>('keyword')
  @IsIn(RULE_ACTIONS)
  keyword?: RuleAction;

  @unlessAbsent<RuleActionsPatchDto>('url')
  @IsIn(RULE_ACTIONS)
  url?: RuleAction;

  @unlessAbsent<RuleActionsPatchDto>('phone')
  @IsIn(RULE_ACTIONS)
  phone?: RuleAction;
}

/** Static rule changes (M6-T1). Lists replace the stored list; limits are checked after normalising. */
export class RulesPatchDto {
  @unlessAbsent<RulesPatchDto>('blockedKeywords')
  @IsArray()
  @IsString({ each: true })
  blockedKeywords?: string[];

  @unlessAbsent<RulesPatchDto>('blockUrls')
  @IsBoolean()
  blockUrls?: boolean;

  @unlessAbsent<RulesPatchDto>('blockPhoneNumbers')
  @IsBoolean()
  blockPhoneNumbers?: boolean;

  @unlessAbsent<RulesPatchDto>('allowedDomains')
  @IsArray()
  @IsString({ each: true })
  allowedDomains?: string[];

  @unlessAbsent<RulesPatchDto>('actions')
  @IsObject()
  @ValidateNested()
  @Type(() => RuleActionsPatchDto)
  actions?: RuleActionsPatchDto;
}

/**
 * `PATCH …/moderation/policy` body. Every field optional, at least one must change something
 * (else 400). Unknown fields → 400; strings are never coerced to numbers/booleans.
 */
export class UpdateModerationPolicyDto {
  @unlessAbsent<UpdateModerationPolicyDto>('mode')
  @IsIn(MODERATION_MODES)
  mode?: ModerationMode;

  /** 0.5–1, at most 3 decimals (stored `numeric(4,3)`). */
  @unlessAbsent<UpdateModerationPolicyDto>('confidenceThreshold')
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 3 })
  @Min(MIN_CONFIDENCE_THRESHOLD)
  @Max(MAX_CONFIDENCE_THRESHOLD)
  confidenceThreshold?: number;

  @unlessAbsent<UpdateModerationPolicyDto>('aiContextLevel')
  @IsIn(CONTEXT_LEVELS)
  aiContextLevel?: ContextLevel;

  @unlessAbsent<UpdateModerationPolicyDto>('categories')
  @IsObject()
  @ValidateNested()
  @Type(() => CategoriesPatchDto)
  categories?: CategoriesPatchDto;

  @unlessAbsent<UpdateModerationPolicyDto>('rules')
  @IsObject()
  @ValidateNested()
  @Type(() => RulesPatchDto)
  rules?: RulesPatchDto;
}
