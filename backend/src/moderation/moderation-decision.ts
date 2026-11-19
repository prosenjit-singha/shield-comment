import type { PlanFeatureConfig } from '../db/schema/index.js';
import type { ClassificationOutput } from './classifier-output.js';
import type { CommentStatus, PolicyAction } from './moderation.constants.js';
import type { ModerationPolicy } from './moderation.queries.js';

/**
 * Pure moderation decision (M5-T8; D3, D4, D6, D10, D11 answered 2026-11-19). The worker (M5-T12)
 * calls `decideAction` after a successful classification and hands the result to the executor
 * (M5-T9). No I/O, no clock: same inputs → same decision.
 */

/** What the classifier said (the fields the decision needs). */
export type DecisionClassification = Pick<
  ClassificationOutput,
  'category' | 'confidence' | 'language'
>;

/** Plan flags the decision reads (`normalizeFeatureConfig(...).features`; no plan = Free plan). */
export type DecisionPlanFeatures = Pick<
  PlanFeatureConfig['features'],
  'autoReplyTemplates'
>;

/** The comment as stored before this decision. */
export interface DecisionCurrent {
  status: CommentStatus;
  /** D10 human stamp: set → the AI never changes the comment again. */
  overriddenAt: Date | null;
  /** Deleted on Meta (author removed it, webhook verb `remove`). */
  deletedAt: Date | null;
  /**
   * `true` when the comment is hidden on Meta because of an AUTO `HIDE` (the last SUCCEEDED
   * HIDE/UNHIDE action has source `AUTO`). Only such a comment may be un-hidden by the AI (D11).
   */
  hiddenByAi: boolean;
  /** An AUTO `REPLY` action already exists for the comment (D6: at most one auto-reply). */
  autoReplied: boolean;
}

/** Meta action to run (`NONE` = no Graph call for moderation; a reply may still be sent). */
export type DecisionAction = 'NONE' | 'HIDE' | 'UNHIDE' | 'DELETE';

/** Why the decision came out this way: a machine code (fits `comments.status_reason`). */
export const DECISION_REASONS = [
  /** At/above the threshold in AUTO mode: the category's policy action applies. */
  'policy',
  /** D11: an AI-hidden comment was edited and is now safe (category action NONE) → un-hide. */
  'ai_unhide',
  /** Already in the target state (e.g. hidden and the policy says hide): nothing to do. */
  'already_applied',
  /** Policy NONE on a comment hidden on Meta but not by an AUTO hide: the AI leaves it hidden. */
  'hidden_by_other',
  /** D4: confidence below the workspace threshold → no action. */
  'below_threshold',
  /** Mode `REVIEW`: a result that would have acted is not applied. */
  'review_mode',
  /** D10: a human decided on this comment; the AI never changes it. */
  'human_override',
  /** The comment is deleted (on Meta or by us): nothing more to do, no reply (D6). */
  'comment_deleted',
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

/** Auto-reply text to post (D6): `bn` for Bangla script and Banglish comments, `en` otherwise. */
export interface DecisionReply {
  language: 'en' | 'bn';
  text: string;
}

export interface ModerationDecision {
  action: DecisionAction;
  /** Comment status once the action (if any) succeeded. */
  status: CommentStatus;
  reason: DecisionReason;
  reply?: DecisionReply;
}

/**
 * Decision table (first match wins):
 * 1. deleted (`deletedAt` or status `DELETED`) → NONE, status kept, `comment_deleted`, no reply;
 * 2. human-stamped (`overriddenAt`) → NONE, status kept, `human_override`, no reply;
 * 3. `confidence < threshold` (D4) → NONE, `below_threshold`, no reply; status `NEEDS_REVIEW`,
 *    except a comment that is hidden on Meta stays `HIDDEN` (status mirrors Meta: no action ran);
 * 4. the wanted action = the category's policy action (`NONE`/`HIDE`/`DELETE`) relative to the
 *    current state: HIDE on a hidden comment = nothing; NONE on an AI-hidden comment = `UNHIDE`
 *    (D11); NONE on a comment hidden but not by the AI = nothing (stays `HIDDEN`, `hidden_by_other`); DELETE = `DELETE`
 *    (also escalates a hidden comment);
 * 5. mode `REVIEW` and the wanted action is not NONE → NONE, `review_mode`, no reply; status
 *    `NEEDS_REVIEW` (or `HIDDEN` when hidden on Meta);
 * 6. otherwise the wanted action with its status (`VISIBLE`/`HIDDEN`/`DELETED`) and reason
 *    `policy` / `ai_unhide` / `already_applied`, plus a reply when all of: plan has
 *    `autoReplyTemplates`, the category's switch is on, both texts set, the action is not
 *    `DELETE`, no AUTO reply yet (D6). REVIEW mode never replies.
 */
export function decideAction(
  policy: Pick<ModerationPolicy, 'mode' | 'confidenceThreshold' | 'categories'>,
  classification: DecisionClassification,
  planFeatures: DecisionPlanFeatures,
  current: DecisionCurrent,
): ModerationDecision {
  if (current.deletedAt !== null || current.status === 'DELETED') {
    return {
      action: 'NONE',
      status: current.status,
      reason: 'comment_deleted',
    };
  }
  if (current.overriddenAt !== null) {
    return { action: 'NONE', status: current.status, reason: 'human_override' };
  }

  const hidden = current.status === 'HIDDEN';
  const idleStatus: CommentStatus = hidden ? 'HIDDEN' : 'NEEDS_REVIEW';
  if (classification.confidence < policy.confidenceThreshold) {
    return { action: 'NONE', status: idleStatus, reason: 'below_threshold' };
  }

  const rule = policy.categories[classification.category];
  const wanted = wantedAction(rule.action, hidden, current.hiddenByAi);
  if (policy.mode === 'REVIEW' && wanted.action !== 'NONE') {
    return { action: 'NONE', status: idleStatus, reason: 'review_mode' };
  }

  const decision: ModerationDecision = { ...wanted };
  if (
    policy.mode === 'AUTO' &&
    planFeatures.autoReplyTemplates &&
    rule.autoReply &&
    rule.replyEn !== null &&
    rule.replyBn !== null &&
    wanted.action !== 'DELETE' &&
    !current.autoReplied
  ) {
    decision.reply =
      classification.language === 'en'
        ? { language: 'en', text: rule.replyEn }
        : { language: 'bn', text: rule.replyBn };
  }
  return decision;
}

function wantedAction(
  policyAction: PolicyAction,
  hidden: boolean,
  hiddenByAi: boolean,
): Omit<ModerationDecision, 'reply'> {
  switch (policyAction) {
    case 'DELETE':
      return { action: 'DELETE', status: 'DELETED', reason: 'policy' };
    case 'HIDE':
      return hidden
        ? { action: 'NONE', status: 'HIDDEN', reason: 'already_applied' }
        : { action: 'HIDE', status: 'HIDDEN', reason: 'policy' };
    case 'NONE':
      if (!hidden)
        return { action: 'NONE', status: 'VISIBLE', reason: 'policy' };
      return hiddenByAi
        ? { action: 'UNHIDE', status: 'VISIBLE', reason: 'ai_unhide' }
        : { action: 'NONE', status: 'HIDDEN', reason: 'hidden_by_other' };
  }
}
