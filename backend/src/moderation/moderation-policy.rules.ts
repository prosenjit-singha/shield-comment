import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PlanFeatureConfig } from '../db/schema/plans.js';
import type { DecisionPlanFeatures } from './moderation-decision.js';
import {
  type CategoriesPatchDto,
  MODERATION_POLICY_ERROR_CODES,
  type ModerationPolicyResponse,
  type RulesPatchDto,
  type UpdateModerationPolicyDto,
} from './dto/moderation-policy.dto.js';
import {
  MAX_ALLOWED_DOMAINS,
  MAX_BLOCKED_KEYWORDS,
  MAX_KEYWORD_CHARS,
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_KEYS,
  type ModerationCategory,
  RULE_KINDS,
} from './moderation.constants.js';
import {
  type CategoryRule,
  type ModerationPolicy,
  type ModerationPolicyRow,
  toModerationPolicy,
} from './moderation.queries.js';
import { normalizeDomain, normalizeRuleText } from './rule-text.js';

/** Pure helpers of the policy API (M5-T8, rules M6-T1): patch merge, checks, diff, row values. */

/** Plan flags the policy API reads (D6 auto-reply; M6 D4 rules). */
export type PolicyPlanFeatures = DecisionPlanFeatures &
  Pick<PlanFeatureConfig['features'], 'customBlocklist' | 'autoHideScams'>;

const hasDefined = (o: object | undefined): boolean =>
  o !== undefined && Object.values(o).some((v) => v !== undefined);

/** `true` when the body names nothing to change (no field, or only empty nested objects). */
export function isEmptyPolicyPatch(patch: UpdateModerationPolicyDto): boolean {
  const { categories, rules, ...top } = patch;
  if (hasDefined(top)) return false;
  if (
    categories &&
    MODERATION_CATEGORIES.some((c) => hasDefined(categories[c]))
  )
    return false;
  if (!rules) return true;
  const { actions, ...lists } = rules;
  return !hasDefined(lists) && !hasDefined(actions);
}

const badRequest = (
  message: string,
  code: string,
  details: Record<string, unknown>,
) =>
  new BadRequestException({
    message,
    error: 'Bad Request',
    code,
    details,
  });

/**
 * D5/D6: the rules patch with its lists normalised and de-duplicated (first spelling wins), or a
 * 400 with a `code` (blank / too long keyword, too many keywords, bad domain, too many domains).
 */
export function normalizeRulesPatch(rules: RulesPatchDto): RulesPatchDto {
  return {
    blockedKeywords:
      rules.blockedKeywords && normalizeKeywords(rules.blockedKeywords),
    blockUrls: rules.blockUrls,
    blockPhoneNumbers: rules.blockPhoneNumbers,
    allowedDomains:
      rules.allowedDomains && normalizeDomains(rules.allowedDomains),
    actions: rules.actions,
  };
}

function normalizeKeywords(list: readonly string[]): string[] {
  const keywords = new Set<string>();
  for (const raw of list) {
    const keyword = normalizeRuleText(raw);
    // Code points, like Postgres `char_length` and the DB check.
    const chars = Array.from(keyword).length;
    if (chars < 1 || chars > MAX_KEYWORD_CHARS) {
      throw badRequest(
        `Each blocked keyword needs 1–${MAX_KEYWORD_CHARS} characters.`,
        MODERATION_POLICY_ERROR_CODES.blockedKeywordInvalid,
        { keyword: raw },
      );
    }
    keywords.add(keyword);
  }
  if (keywords.size > MAX_BLOCKED_KEYWORDS) {
    throw badRequest(
      `At most ${MAX_BLOCKED_KEYWORDS} blocked keywords.`,
      MODERATION_POLICY_ERROR_CODES.blockedKeywordsLimit,
      { max: MAX_BLOCKED_KEYWORDS },
    );
  }
  return [...keywords];
}

function normalizeDomains(list: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const raw of list) {
    const domain = normalizeDomain(raw);
    if (domain === null) {
      throw badRequest(
        'Allowed domains must be domain names like shop.example.com.',
        MODERATION_POLICY_ERROR_CODES.allowedDomainInvalid,
        { domain: raw },
      );
    }
    domains.add(domain);
  }
  if (domains.size > MAX_ALLOWED_DOMAINS) {
    throw badRequest(
      `At most ${MAX_ALLOWED_DOMAINS} allowed domains.`,
      MODERATION_POLICY_ERROR_CODES.allowedDomainsLimit,
      { max: MAX_ALLOWED_DOMAINS },
    );
  }
  return [...domains];
}

/**
 * The policy after `patch` (fields not sent are kept; `null` texts clear; lists replace). Pure;
 * `patch.rules` lists must already be normalised (`normalizeRulesPatch`).
 */
export function applyPolicyPatch(
  current: ModerationPolicy,
  patch: UpdateModerationPolicyDto,
): ModerationPolicy {
  const { rules } = patch;
  const categories = {} as Record<ModerationCategory, CategoryRule>;
  for (const category of MODERATION_CATEGORIES) {
    const rule = current.categories[category];
    const change = patch.categories?.[category];
    categories[category] = {
      action: change?.action ?? rule.action,
      autoReply: change?.autoReply ?? rule.autoReply,
      replyEn: change?.replyEn !== undefined ? change.replyEn : rule.replyEn,
      replyBn: change?.replyBn !== undefined ? change.replyBn : rule.replyBn,
    };
  }
  return {
    workspaceId: current.workspaceId,
    mode: patch.mode ?? current.mode,
    confidenceThreshold:
      patch.confidenceThreshold ?? current.confidenceThreshold,
    aiContextLevel: patch.aiContextLevel ?? current.aiContextLevel,
    categories,
    rules: {
      blockedKeywords: rules?.blockedKeywords ?? current.rules.blockedKeywords,
      blockUrls: rules?.blockUrls ?? current.rules.blockUrls,
      blockPhoneNumbers:
        rules?.blockPhoneNumbers ?? current.rules.blockPhoneNumbers,
      allowedDomains: rules?.allowedDomains ?? current.rules.allowedDomains,
      actions: {
        keyword: rules?.actions?.keyword ?? current.rules.actions.keyword,
        url: rules?.actions?.url ?? current.rules.actions.url,
        phone: rules?.actions?.phone ?? current.rules.actions.phone,
      },
    },
  };
}

/** Categories whose patch sends `autoReply: true`. */
function switchedOn(
  categories: CategoriesPatchDto | undefined,
): ModerationCategory[] {
  return MODERATION_CATEGORIES.filter(
    (c) => categories?.[c]?.autoReply === true,
  );
}

/**
 * Checks of the merged policy, in this order:
 * 1. the body sends `autoReply: true` for any category and the plan has no
 *    `autoReplyTemplates` → 409 `PLAN_FEATURE_UNAVAILABLE` `details { feature }` (D6). A policy
 *    that already has a switch on (e.g. after a downgrade) can still be edited otherwise;
 * 2. any category ends with auto-reply on without both texts → 400 `AUTO_REPLY_TEXTS_REQUIRED`
 *    `details { category }` (the first one, in category order).
 */
export function assertPolicyPatchAllowed(
  patch: UpdateModerationPolicyDto,
  next: ModerationPolicy,
  features: DecisionPlanFeatures,
): void {
  if (!features.autoReplyTemplates && switchedOn(patch.categories).length > 0) {
    throw new ConflictException({
      message:
        'Auto-replies are not included in your plan. Upgrade to Growth or Pro to switch them on.',
      error: 'Conflict',
      code: MODERATION_POLICY_ERROR_CODES.planFeatureUnavailable,
      details: { feature: 'autoReplyTemplates' },
    });
  }
  const missing = MODERATION_CATEGORIES.find((c) => {
    const rule = next.categories[c];
    return rule.autoReply && (rule.replyEn === null || rule.replyBn === null);
  });
  if (missing) {
    throw new BadRequestException({
      message:
        'An auto-reply needs both an English and a Bangla text before it can be switched on.',
      error: 'Bad Request',
      code: MODERATION_POLICY_ERROR_CODES.autoReplyTextsRequired,
      details: { category: missing },
    });
  }
}

const planFeatureUnavailable = (message: string, feature: string) =>
  new ConflictException({
    message,
    error: 'Conflict',
    code: MODERATION_POLICY_ERROR_CODES.planFeatureUnavailable,
    details: { feature },
  });

/**
 * D4 gating of the static rules (409 `PLAN_FEATURE_UNAVAILABLE` `details { feature }`): adding a
 * keyword needs `customBlocklist`; switching the URL / phone rule on needs `autoHideScams`. Like
 * auto-reply, a downgraded workspace may still remove keywords, switch rules off and edit the rest.
 */
export function assertRulesPatchAllowed(
  current: ModerationPolicy,
  next: ModerationPolicy,
  features: PolicyPlanFeatures,
): void {
  const stored = new Set(current.rules.blockedKeywords);
  if (
    !features.customBlocklist &&
    next.rules.blockedKeywords.some((k) => !stored.has(k))
  ) {
    throw planFeatureUnavailable(
      'Custom blocked keywords are not included in your plan. Upgrade to Growth or Pro to add them.',
      'customBlocklist',
    );
  }
  const switchedOnRule =
    (next.rules.blockUrls && !current.rules.blockUrls) ||
    (next.rules.blockPhoneNumbers && !current.rules.blockPhoneNumbers);
  if (!features.autoHideScams && switchedOnRule) {
    throw planFeatureUnavailable(
      'Link and phone number blocking needs an active plan.',
      'autoHideScams',
    );
  }
}

/** `true` when both lists hold the same values in the same order. */
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** `true` when both policies store the same values. */
export function samePolicy(a: ModerationPolicy, b: ModerationPolicy): boolean {
  if (
    a.mode !== b.mode ||
    a.confidenceThreshold !== b.confidenceThreshold ||
    a.aiContextLevel !== b.aiContextLevel ||
    a.rules.blockUrls !== b.rules.blockUrls ||
    a.rules.blockPhoneNumbers !== b.rules.blockPhoneNumbers ||
    !sameList(a.rules.blockedKeywords, b.rules.blockedKeywords) ||
    !sameList(a.rules.allowedDomains, b.rules.allowedDomains) ||
    RULE_KINDS.some((k) => a.rules.actions[k] !== b.rules.actions[k])
  ) {
    return false;
  }
  return MODERATION_CATEGORIES.every((c) => {
    const x = a.categories[c];
    const y = b.categories[c];
    return (
      x.action === y.action &&
      x.autoReply === y.autoReply &&
      x.replyEn === y.replyEn &&
      x.replyBn === y.replyBn
    );
  });
}

/** Policy → the flat columns of `moderation_policies` (without the key and timestamps). */
export function policyColumns(
  policy: ModerationPolicy,
): Partial<ModerationPolicyRow> {
  const values: Record<string, unknown> = {
    mode: policy.mode,
    confidenceThreshold: policy.confidenceThreshold,
    aiContextLevel: policy.aiContextLevel,
    blockedKeywords: policy.rules.blockedKeywords,
    blockUrls: policy.rules.blockUrls,
    blockPhoneNumbers: policy.rules.blockPhoneNumbers,
    allowedDomains: policy.rules.allowedDomains,
    keywordRuleAction: policy.rules.actions.keyword,
    urlRuleAction: policy.rules.actions.url,
    phoneRuleAction: policy.rules.actions.phone,
  };
  for (const category of MODERATION_CATEGORIES) {
    const key = MODERATION_CATEGORY_KEYS[category];
    const rule = policy.categories[category];
    values[`${key}Action`] = rule.action;
    values[`${key}AutoReply`] = rule.autoReply;
    values[`${key}ReplyEn`] = rule.replyEn;
    values[`${key}ReplyBn`] = rule.replyBn;
  }
  return values as Partial<ModerationPolicyRow>;
}

/** Stored row → API body. */
export function toPolicyResponse(
  row: ModerationPolicyRow,
  features: PolicyPlanFeatures,
): ModerationPolicyResponse {
  return {
    ...toModerationPolicy(row),
    autoReplyAvailable: features.autoReplyTemplates,
    keywordRulesAvailable: features.customBlocklist,
    urlPhoneRulesAvailable: features.autoHideScams,
    updatedAt: row.updatedAt,
  };
}
