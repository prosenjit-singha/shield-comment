import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DecisionPlanFeatures } from './moderation-decision.js';
import {
  type CategoriesPatchDto,
  MODERATION_POLICY_ERROR_CODES,
  type ModerationPolicyResponse,
  type UpdateModerationPolicyDto,
} from './dto/moderation-policy.dto.js';
import {
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_KEYS,
  type ModerationCategory,
} from './moderation.constants.js';
import {
  type CategoryRule,
  type ModerationPolicy,
  type ModerationPolicyRow,
  toModerationPolicy,
} from './moderation.queries.js';

/** Pure helpers of the policy API (M5-T8): patch merge, checks, diff, row values. */

const hasDefined = (o: object | undefined): boolean =>
  o !== undefined && Object.values(o).some((v) => v !== undefined);

/** `true` when the body names nothing to change (no field, or only empty category objects). */
export function isEmptyPolicyPatch(patch: UpdateModerationPolicyDto): boolean {
  const { categories, ...top } = patch;
  if (hasDefined(top)) return false;
  if (!categories) return true;
  return !MODERATION_CATEGORIES.some((c) => hasDefined(categories[c]));
}

/** The policy after `patch` (fields not sent are kept; `null` texts clear). Pure. */
export function applyPolicyPatch(
  current: ModerationPolicy,
  patch: UpdateModerationPolicyDto,
): ModerationPolicy {
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

/** `true` when both policies store the same values. */
export function samePolicy(a: ModerationPolicy, b: ModerationPolicy): boolean {
  if (
    a.mode !== b.mode ||
    a.confidenceThreshold !== b.confidenceThreshold ||
    a.aiContextLevel !== b.aiContextLevel
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
  features: DecisionPlanFeatures,
): ModerationPolicyResponse {
  return {
    ...toModerationPolicy(row),
    autoReplyAvailable: features.autoReplyTemplates,
    updatedAt: row.updatedAt,
  };
}
