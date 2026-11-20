import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  dhakaDayKey,
  type DailyCommentStatsDelta,
  incrementDailyCommentStats,
} from '../comments/comments.queries.js';
import type { Database } from '../db/database.js';
import type { DailyCommentCounter } from '../db/schema/comments.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { ClassifierInput } from './classifier-input.js';
import type { ModerateCommentTarget } from './comment-moderation.job.js';
import {
  type AutoActionFlags,
  clearCommentCounted,
  findAutoActionFlags,
  findWorkspaceBillingAccountId,
  lockModerationComment,
  markCommentCounted,
  type ModerationComment,
  type ModerationStatePatch,
  type ModerationWorkerExecutor,
  updateModerationState,
} from './comment-moderation.queries.js';
import {
  commentIsReply,
  decisionStatusReason,
  type ModerationWorkerSkip,
  needsMeta,
  preClassifySkip,
  sameVersion,
  skipSetsStatus,
  statusWhenUnfinished,
} from './comment-moderation.rules.js';
import {
  type ClassificationFailure,
  type ClassificationSuccess,
  CommentClassifier,
} from './comment-classifier.js';
import { ModerationActionExecutor } from './moderation-action.executor.js';
import {
  type DecisionClassification,
  decideAction,
  decideRuleAction,
  type ModerationDecision,
} from './moderation-decision.js';
import type { PolicyPlanFeatures } from './moderation-policy.rules.js';
import {
  ModerationPolicyService,
  workspacePlanFeatures,
} from './moderation-policy.service.js';
import {
  type CommentStatus,
  MODERATION_CATEGORY_KEYS,
  type ModerationStage,
  RULE_STATUS_REASONS,
  type RuleKind,
} from './moderation.constants.js';
import {
  classificationUsageDelta,
  type ModerationPolicy,
  recordDailyAiUsage,
} from './moderation.queries.js';
import { PostContextService } from './post-context.service.js';
import {
  matchStaticRules,
  rulesForPlan,
  type StaticRuleMatch,
} from './static-rules.js';

/** What one `moderate-comment` job did (the job's return value; ids and codes only). */
export type ModerationResult =
  | { kind: 'skipped'; reason: ModerationWorkerSkip }
  | {
      kind: 'moderated';
      /** Classified in this run (`false` = a retry that only finished the Meta step, or a rule). */
      classified: boolean;
      /** M6-T2: a static rule decided (no AI call). */
      rule?: RuleKind;
      /** This run counted the comment against the monthly comment limit (PW-D1/D2: once). */
      counted: boolean;
      action: ModerationDecision['action'];
      status: CommentStatus;
      replied: boolean;
      /** Why the Meta step did not run as decided (e.g. `connection_needs_reauth`), if so. */
      metaSkip?: string;
    };

/**
 * A step failed. `retryable` = worth a BullMQ retry (transient AI / Graph kinds, D2); the worker
 * rethrows those and turns the rest into `UnrecoverableError`.
 */
export class ModerationStepError extends Error {
  constructor(
    readonly step: 'classify' | 'act',
    readonly kind: string,
    readonly retryable: boolean,
  ) {
    super(`comment-moderation: ${step} failed (${kind})`);
    this.name = 'ModerationStepError';
  }
}

export interface ModerationAttempt {
  /** The job's last try: a failure now writes `FAILED` (D2). */
  finalAttempt: boolean;
}

type Counters = Partial<Record<DailyCommentCounter, number>>;

/** What decided a comment version: the AI classification or a static rule (M6-T2). */
interface Verdict {
  decide(
    current: ModerationComment,
    flags: AutoActionFlags,
  ): ModerationDecision;
  /** The columns the verdict writes (classification + `rule_match` null, or the rule match). */
  patch: ModerationStatePatch;
  counters: Counters;
  statusReason(decision: ModerationDecision): string | null;
  rule?: RuleKind;
  /** Log label (kinds and scores only, never text or matched values). */
  label: string;
}

/** Ran in this run: counted against the monthly comments, classified by the AI, or a rule. */
interface RunFacts {
  counted: boolean;
  classified: boolean;
  rule?: RuleKind;
}

type Prepared =
  | { kind: 'done'; result: ModerationResult }
  | { kind: 'work'; comment: ModerationComment };

/**
 * The PW-T4 usage step before the AI call: `counted` with the instant this run counted the
 * comment (`null` = counted before: an edit re-check or a retry, free), or the skip.
 */
type UsageStep =
  | { kind: 'counted'; countedAt: Date | null }
  | { kind: 'skipped'; reason: 'comment_limit_reached' | 'no_active_plan' };

/** The wallet meter one moderated comment uses (PW-D1). */
const COMMENT_METER = 'monthlyComments';

/**
 * One comment version through moderation (M5-T12; D2/D3/D4/D6/D8/D11/D13; PW-T4: PW-D1/D2/D9).
 *
 * tx1 (`FOR UPDATE`): version + stage check, D13/D10 skips → usage: a comment not counted yet
 * (`usage_counted_at` null) is counted once, `WalletService.consume(monthlyComments, 1, at)` +
 * `usage_counted_at = at` (`limit_reached` → `SKIPPED comment_limit_reached`, `no_active_plan` →
 * `SKIPPED no_active_plan`, no AI call); a counted one (edit re-check, retry) is free → policy +
 * D8 context (Graph caption outside any tx) → `classify()` (no tx) → tx2: classification +
 * counts; when Meta must act the stage becomes `act` → executor (Graph outside any tx) → tx3:
 * status / stage / counts.
 *
 * Idempotency: `comments.moderation_stage` + `edited_at` are the version marker. A duplicate job or
 * a retry after success finds the stage cleared (`already_moderated`); a retry after a failed Meta
 * step finds `act` and only acts (no second AI call, no count). When this run counted the comment
 * and the LLM was never reached, the count is given back (`refund` at the same instant) and
 * `usage_counted_at` cleared. Logs ids, kinds and counts only: never comment text, captions, Page
 * names or replies.
 */
@Injectable()
export class CommentModerationService {
  private readonly logger = new Logger('CommentModeration');
  /** PW-T4: one "comment limit reached" warning per account per Dhaka day (per process). */
  private limitWarnings: { day: string; accounts: Set<string> } = {
    day: '',
    accounts: new Set(),
  };

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly policies: ModerationPolicyService,
    private readonly postContext: PostContextService,
    private readonly wallet: WalletService,
    private readonly classifier: CommentClassifier,
    private readonly executor: ModerationActionExecutor,
  ) {}

  async moderate(
    target: ModerateCommentTarget,
    attempt: ModerationAttempt,
    now: () => Date = () => new Date(),
  ): Promise<ModerationResult> {
    const prepared = await this.db.transaction((tx) =>
      this.prepare(tx, target, now()),
    );
    if (prepared.kind === 'done') return prepared.result;
    const { comment } = prepared;
    const policy = await this.policies.policy(target.workspaceId);

    // A rule-decided version (`rule_match` set) re-runs the rules in `classify()` (free: counted).
    if (comment.moderationStage === 'act' && comment.ruleMatch === null) {
      const stored = storedClassification(comment);
      if (stored) {
        const decision = decideAction(
          policy,
          stored,
          await workspacePlanFeatures(this.db, comment.workspaceId),
          {
            status: comment.status,
            overriddenAt: comment.overriddenAt,
            deletedAt: comment.deletedAt,
            ...(await findAutoActionFlags(
              this.db,
              comment.workspaceId,
              comment.id,
            )),
          },
        );
        return this.act(
          comment,
          decision,
          decisionStatusReason(decision),
          { counted: false, classified: false },
          attempt,
          now,
        );
      }
    }
    return this.classify(comment, policy, target, attempt, now);
  }

  /** tx1: lock, version/stage check, skip rules (a skip is written here). */
  private async prepare(
    tx: ModerationWorkerExecutor,
    target: ModerateCommentTarget,
    at: Date,
  ): Promise<Prepared> {
    const comment = await lockModerationComment(
      tx,
      target.workspaceId,
      target.commentRowId,
    );
    const done = (reason: ModerationWorkerSkip): Prepared => {
      this.logger.debug(
        `Comment ${target.commentRowId} (workspace ${target.workspaceId}): skipped (${reason})`,
      );
      return { kind: 'done', result: { kind: 'skipped', reason } };
    };
    if (!comment) return done('comment_not_found');
    if (!sameVersion(comment.editedAt, target.editedAt)) {
      return done('stale_version');
    }
    if (comment.moderationStage === null) return done('already_moderated');

    const skip = preClassifySkip(comment);
    if (skip === null) return { kind: 'work', comment };
    // An `act` stage on a comment a human took over (or that was deleted) is finished too.
    await this.finishSkipped(tx, comment, comment.moderationStage, skip, at);
    return done(skip);
  }

  private async classify(
    comment: ModerationComment,
    policy: ModerationPolicy,
    target: ModerateCommentTarget,
    attempt: ModerationAttempt,
    now: () => Date,
  ): Promise<ModerationResult> {
    const usage = await this.countUsage(comment, now);
    if (usage.kind === 'skipped') {
      await this.db.transaction((tx) =>
        this.finishSkipped(tx, comment, 'classify', usage.reason, now()),
      );
      if (usage.reason === 'comment_limit_reached') {
        await this.warnLimitReached(comment.workspaceId, now());
      }
      return { kind: 'skipped', reason: usage.reason };
    }
    const { countedAt } = usage;

    // M6-T2 (D3: after the usage step): a static rule match skips the post context and the LLM.
    // Only the rules the live plan allows run (`rulesForPlan`).
    const plan = await workspacePlanFeatures(this.db, comment.workspaceId);
    const match = matchStaticRules(
      comment.message,
      rulesForPlan(policy.rules, plan),
    );
    if (match !== null) {
      return this.ruleMatched(
        comment,
        policy,
        match,
        countedAt !== null,
        attempt,
        now,
      );
    }

    let result;
    try {
      const context = await this.postContext.forComment(
        {
          workspaceId: comment.workspaceId,
          socialPageId: comment.socialPageId,
          platform: comment.platform,
          postId: comment.postId,
        },
        policy.aiContextLevel,
        now,
      );
      const input: ClassifierInput = {
        text: comment.message ?? '',
        platform: comment.platform,
        isReply: commentIsReply(
          comment.platform,
          comment.postId,
          comment.rawPayload,
        ),
        contextLevel: policy.aiContextLevel,
        pageName: context.pageName,
        postCaption: context.postCaption,
      };
      result = await this.classifier.classify(input);
    } catch (error) {
      // Not an AI failure (e.g. a DB read failed): nothing reached the LLM.
      await this.giveBack(comment, countedAt, now);
      throw error;
    }

    if (!result.ok) {
      return this.classifyFailed(
        comment,
        target,
        result,
        countedAt,
        attempt,
        now,
      );
    }
    await this.recordUsage(result, now());
    return this.classified(
      comment,
      policy,
      result,
      plan,
      countedAt !== null,
      attempt,
      now,
    );
  }

  /**
   * PW-T4 (PW-D1/D2/D9): counts the comment once before its first AI call. A comment counted
   * before runs free. `ok` → `usage_counted_at` = the consume's instant (guarded: if another run
   * counted it first, this run's count is given back and it runs free).
   */
  private async countUsage(
    comment: ModerationComment,
    now: () => Date,
  ): Promise<UsageStep> {
    if (comment.usageCountedAt !== null) {
      return { kind: 'counted', countedAt: null };
    }
    const at = now();
    const outcome = await this.wallet.consume(
      comment.workspaceId,
      COMMENT_METER,
      1,
      at,
    );
    if (outcome === 'limit_reached') {
      return { kind: 'skipped', reason: 'comment_limit_reached' };
    }
    if (outcome === 'no_active_plan') {
      return { kind: 'skipped', reason: 'no_active_plan' };
    }
    if (
      await markCommentCounted(this.db, comment.workspaceId, comment.id, at)
    ) {
      return { kind: 'counted', countedAt: at };
    }
    await this.wallet.refund(comment.workspaceId, COMMENT_METER, 1, at);
    return { kind: 'counted', countedAt: null };
  }

  /**
   * The LLM was never reached: gives this run's count back (`refund` in the period containing
   * `countedAt`) and clears `usage_counted_at`. A no-op when this run did not count the comment.
   */
  private async giveBack(
    comment: ModerationComment,
    countedAt: Date | null,
    now: () => Date,
  ): Promise<void> {
    if (countedAt === null) return;
    await clearCommentCounted(
      this.db,
      comment.workspaceId,
      comment.id,
      countedAt,
      now(),
    );
    await this.wallet.refund(comment.workspaceId, COMMENT_METER, 1, countedAt);
  }

  private async classifyFailed(
    comment: ModerationComment,
    target: ModerateCommentTarget,
    failure: ClassificationFailure,
    countedAt: Date | null,
    attempt: ModerationAttempt,
    now: () => Date,
  ): Promise<never> {
    // PW-T4: a call that produced tokens reached the LLM, so the comment stays counted (a later
    // run is free); one that never got an answer gives this run's count back.
    const reached = failure.usage !== undefined;
    if (!reached) await this.giveBack(comment, countedAt, now);
    await this.recordUsage(failure, now());
    const final = !failure.retryable || attempt.finalAttempt;
    if (final) {
      await this.db.transaction(async (tx) => {
        // D2: fail open. The stage stays `classify`, so the sweeper retries within 24 h.
        const status = statusWhenUnfinished(comment.status, 'FAILED');
        const patch: ModerationStatePatch = { status };
        if (status === 'FAILED') patch.statusReason = failure.kind;
        const applied = await updateModerationState(
          tx,
          { ...target, stage: 'classify' },
          patch,
          now(),
        );
        if (applied) await this.count(tx, comment, { failed: 1 }, now());
      });
    }
    const counted = countedAt !== null && reached;
    this.logger.warn(
      `Comment ${comment.id} (workspace ${comment.workspaceId}): classification failed (${failure.kind}, attempts ${failure.attempts}, counted ${counted ? 1 : 0}${final ? ', final' : ', will retry'})`,
    );
    throw new ModerationStepError('classify', failure.kind, failure.retryable);
  }

  /** The AI verdict (tx2 stores the classification and clears `rule_match`). */
  private async classified(
    comment: ModerationComment,
    policy: ModerationPolicy,
    result: ClassificationSuccess,
    plan: PolicyPlanFeatures,
    counted: boolean,
    attempt: ModerationAttempt,
    now: () => Date,
  ): Promise<ModerationResult> {
    return this.decided(
      comment,
      {
        decide: (current, flags) =>
          decideAction(policy, result, plan, {
            status: current.status,
            overriddenAt: current.overriddenAt,
            deletedAt: current.deletedAt,
            ...flags,
          }),
        patch: {
          classification: {
            category: result.category,
            confidence: result.confidence,
            reasoning: result.reasoning,
            language: result.language,
            classifiedAt: now(),
            aiProvider: result.provider,
            model: result.model,
            promptVersion: result.promptVersion,
            contextLevel: result.contextLevel,
            aiInputTokens: result.usage?.promptTokens ?? null,
            aiOutputTokens: result.usage?.completionTokens ?? null,
            aiLatencyMs: result.latencyMs,
          },
          ruleMatch: null,
        },
        counters: {
          classified: 1,
          [MODERATION_CATEGORY_KEYS[result.category]]: 1,
        },
        statusReason: decisionStatusReason,
        label: `classified ${result.category} (${result.confidence}, ${result.contextLevel}`,
      },
      { counted, classified: true },
      attempt,
      now,
    );
  }

  /**
   * M6-T2 (Module 6 D2 b): a static rule matched. No AI call and no classification columns:
   * `rule_match` = the value, `status_reason` = `rule_<kind>`, `ruleMatched` counter, the action
   * = the policy's `rules.actions[kind]` through the same executor path (REVIEW → `NEEDS_REVIEW`).
   */
  private async ruleMatched(
    comment: ModerationComment,
    policy: ModerationPolicy,
    match: StaticRuleMatch,
    counted: boolean,
    attempt: ModerationAttempt,
    now: () => Date,
  ): Promise<ModerationResult> {
    const reason = RULE_STATUS_REASONS[match.kind];
    const run: RunFacts = { counted, classified: false, rule: match.kind };
    if (comment.moderationStage === 'act') {
      // A retry after a failed Meta step: stored and counted before, only act again.
      return this.act(
        comment,
        decideRuleAction(policy, match.kind, comment),
        reason,
        run,
        attempt,
        now,
      );
    }
    return this.decided(
      comment,
      {
        decide: (current) => decideRuleAction(policy, match.kind, current),
        patch: { ruleMatch: match.value },
        counters: { ruleMatched: 1 },
        statusReason: () => reason,
        rule: match.kind,
        label: `rule ${match.kind} matched (`,
      },
      run,
      attempt,
      now,
    );
  }

  /** tx2: store the verdict and decide; finish here when Meta has nothing to do. */
  private async decided(
    comment: ModerationComment,
    verdict: Verdict,
    run: RunFacts,
    attempt: ModerationAttempt,
    now: () => Date,
  ): Promise<ModerationResult> {
    // `act` only when a rule-decided version no longer matches on a retry (the AI decides now).
    const stage: ModerationStage = comment.moderationStage ?? 'classify';
    const stored = await this.db.transaction(async (tx) => {
      const at = now();
      const current = await lockModerationComment(
        tx,
        comment.workspaceId,
        comment.id,
      );
      const version = {
        workspaceId: comment.workspaceId,
        commentRowId: comment.id,
        editedAt: comment.editedAt,
        stage,
      };
      if (
        !current ||
        !sameVersion(current.editedAt, comment.editedAt) ||
        current.moderationStage !== stage
      ) {
        // A newer edit (its own job decides it, free: the comment is counted) or another run
        // finished first. The count stays.
        return null;
      }
      const flags = await findAutoActionFlags(
        tx,
        comment.workspaceId,
        comment.id,
      );
      const decision = verdict.decide(current, flags);
      const metaSkip =
        needsMeta(decision) && current.connectionStatus !== 'ACTIVE'
          ? 'connection_needs_reauth'
          : null;
      const patch: ModerationStatePatch = { ...verdict.patch };
      if (metaSkip !== null) {
        // D13: decided, the Meta action is skipped; visible comments wait for a human.
        const status = statusWhenUnfinished(current.status, 'NEEDS_REVIEW');
        Object.assign(patch, {
          stage: null,
          status,
          ...(status === 'NEEDS_REVIEW' && { statusReason: metaSkip }),
        });
      } else if (needsMeta(decision)) {
        patch.stage = 'act';
      } else {
        Object.assign(patch, {
          stage: null,
          status: decision.status,
          statusReason: verdict.statusReason(decision),
        });
      }
      await updateModerationState(tx, version, patch, at);
      await this.count(tx, current, verdict.counters, at);
      return { current, decision, metaSkip };
    });

    this.logger.log(
      `Comment ${comment.id} (workspace ${comment.workspaceId}): ${verdict.label}, counted ${run.counted ? 1 : 0})${stored ? ` → ${stored.decision.action}` : ' → newer version, not applied'}`,
    );
    if (!stored) return { kind: 'skipped', reason: 'stale_version' };
    const { current, decision, metaSkip } = stored;
    if (metaSkip !== null || !needsMeta(decision)) {
      return {
        kind: 'moderated',
        ...run,
        action: metaSkip === null ? decision.action : 'NONE',
        status:
          metaSkip === null
            ? decision.status
            : statusWhenUnfinished(current.status, 'NEEDS_REVIEW'),
        replied: false,
        ...(metaSkip !== null && { metaSkip }),
      };
    }
    return this.act(
      { ...current, moderationStage: 'act' },
      decision,
      verdict.statusReason(decision),
      run,
      attempt,
      now,
    );
  }

  /**
   * The Meta step (stage `act`): the main action, then the D6 reply. Graph calls run in the
   * executor, outside any transaction; tx3 records the outcome.
   */
  private async act(
    comment: ModerationComment,
    decision: ModerationDecision,
    /** `status_reason` once finished: `decisionStatusReason`, or `rule_<kind>` (M6-T2). */
    statusReason: string | null,
    run: RunFacts,
    attempt: ModerationAttempt,
    now: () => Date,
  ): Promise<ModerationResult> {
    const version = {
      workspaceId: comment.workspaceId,
      commentRowId: comment.id,
      editedAt: comment.editedAt,
      stage: 'act' as ModerationStage,
    };
    const counters: Counters = {};
    let status: CommentStatus = decision.status;
    let metaSkip: string | undefined;
    let replied = false;

    const finish = async (
      patch: ModerationStatePatch,
      error?: ModerationStepError,
    ): Promise<ModerationResult> => {
      await this.db.transaction(async (tx) => {
        await updateModerationState(tx, version, patch, now());
        await this.count(tx, comment, counters, now());
      });
      if (error) throw error;
      return {
        kind: 'moderated',
        ...run,
        action: decision.action,
        status,
        replied,
        ...(metaSkip !== undefined && { metaSkip }),
      };
    };

    if (decision.action !== 'NONE') {
      const result = await this.executor.execute(
        {
          workspaceId: comment.workspaceId,
          commentId: comment.id,
          source: 'AUTO',
          action: decision.action,
        },
        now,
      );
      if (result.outcome === 'succeeded') {
        counters[ACTION_COUNTERS[decision.action]] = 1;
        status = result.commentStatus ?? status;
      } else if (result.outcome === 'skipped') {
        if (
          result.reason === 'human_override' ||
          result.reason === 'comment_deleted' ||
          result.reason === 'comment_not_found'
        ) {
          status = comment.status;
          return finish({ stage: null });
        }
        metaSkip =
          result.reason === 'connection_inactive'
            ? 'connection_needs_reauth'
            : result.reason;
        status = statusWhenUnfinished(comment.status, 'NEEDS_REVIEW');
        return finish({
          stage: null,
          status,
          ...(status === 'NEEDS_REVIEW' && { statusReason: metaSkip }),
        });
      } else {
        const final = !result.retryable || attempt.finalAttempt;
        const error = new ModerationStepError(
          'act',
          result.errorKind,
          result.retryable,
        );
        this.logger.warn(
          `Comment ${comment.id} (workspace ${comment.workspaceId}): AUTO ${decision.action} failed (${result.errorKind}${final ? ', final' : ', will retry'})`,
        );
        if (!final) throw error;
        status = statusWhenUnfinished(comment.status, 'FAILED');
        counters.failed = 1;
        // A transient failure keeps the stage `act`: the sweeper retries the action (no AI call).
        return finish(
          {
            stage: result.retryable ? 'act' : null,
            status,
            ...(status === 'FAILED' && { statusReason: result.errorKind }),
          },
          error,
        );
      }
    }

    if (decision.reply) {
      const reply = await this.executor.execute(
        {
          workspaceId: comment.workspaceId,
          commentId: comment.id,
          source: 'AUTO',
          action: 'REPLY',
          replyText: decision.reply.text,
        },
        now,
      );
      if (reply.outcome === 'succeeded') {
        counters.replied = 1;
        replied = true;
      } else if (reply.outcome === 'failed') {
        const final = !reply.retryable || attempt.finalAttempt;
        this.logger.warn(
          `Comment ${comment.id} (workspace ${comment.workspaceId}): AUTO reply failed (${reply.errorKind}${final ? ', given up' : ', will retry'})`,
        );
        if (!final) {
          // Keep the stage `act`: the retry finds the action applied and only resends the reply.
          return finish(
            {},
            new ModerationStepError('act', reply.errorKind, true),
          );
        }
      }
    }

    return finish({
      stage: null,
      ...(decision.action === 'NONE' && { status: decision.status }),
      statusReason,
    });
  }

  /**
   * Writes a skip: stage cleared; `SKIPPED` + reason (D13, PW-D1/D9), except for a human-stamped comment
   * (D10, untouched) and a comment hidden/deleted on Meta (keeps that status).
   */
  private async finishSkipped(
    tx: ModerationWorkerExecutor,
    comment: ModerationComment,
    stage: ModerationStage,
    reason: ModerationWorkerSkip,
    at: Date,
  ): Promise<void> {
    const setsStatus =
      skipSetsStatus(reason) &&
      statusWhenUnfinished(comment.status, 'SKIPPED') === 'SKIPPED';
    const applied = await updateModerationState(
      tx,
      {
        workspaceId: comment.workspaceId,
        commentRowId: comment.id,
        editedAt: comment.editedAt,
        stage,
      },
      setsStatus
        ? { stage: null, status: 'SKIPPED', statusReason: reason }
        : { stage: null },
      at,
    );
    if (applied && setsStatus) {
      await this.count(tx, comment, { skipped: 1 }, at);
    }
  }

  /** Daily counters of the comment's Page (none for an orphaned comment: no Page id). */
  private async count(
    tx: ModerationWorkerExecutor,
    comment: Pick<ModerationComment, 'workspaceId' | 'platform' | 'page'>,
    counters: Counters,
    at: Date,
  ): Promise<void> {
    if (comment.page === null) return;
    if (!Object.values(counters).some((value) => (value ?? 0) > 0)) return;
    const delta: DailyCommentStatsDelta = {
      workspaceId: comment.workspaceId,
      pageId: comment.page.metaPageId,
      platform: comment.platform,
      day: dhakaDayKey(at),
      ...counters,
    };
    await incrementDailyCommentStats(tx, delta);
  }

  /** D14 aggregate (platform-wide). Never fails the job: the AI call already happened. */
  private async recordUsage(
    result: ClassificationSuccess | ClassificationFailure,
    at: Date,
  ): Promise<void> {
    const delta = classificationUsageDelta(result, dhakaDayKey(at));
    if (!delta) return;
    try {
      await recordDailyAiUsage(this.db, delta);
    } catch (error) {
      this.logger.warn(
        `AI usage not recorded (${error instanceof Error ? error.name : 'unknown error'})`,
      );
    }
  }

  /** PW-T4: one warning per billing account per Dhaka day (ids only); never fails the job. */
  private async warnLimitReached(workspaceId: string, at: Date): Promise<void> {
    let accountId: string | null;
    try {
      accountId = await findWorkspaceBillingAccountId(this.db, workspaceId);
    } catch {
      accountId = null;
    }
    const key = accountId ?? `workspace:${workspaceId}`;
    const day = dhakaDayKey(at);
    if (this.limitWarnings.day !== day) {
      this.limitWarnings = { day, accounts: new Set() };
    }
    if (this.limitWarnings.accounts.has(key)) return;
    this.limitWarnings.accounts.add(key);
    this.logger.warn(
      `Account ${accountId ?? 'none'} (workspace ${workspaceId}): monthly comment limit reached; comments are skipped (comment_limit_reached) until the next reset or a plan change`,
    );
  }
}

const ACTION_COUNTERS = {
  HIDE: 'hidden',
  UNHIDE: 'unhidden',
  DELETE: 'deleted',
} as const satisfies Record<
  Exclude<ModerationDecision['action'], 'NONE'>,
  DailyCommentCounter
>;

/** The classification stored on a comment in stage `act` (`null` if it somehow has none). */
function storedClassification(
  comment: ModerationComment,
): DecisionClassification | null {
  if (
    comment.category === null ||
    comment.confidence === null ||
    comment.language === null
  ) {
    return null;
  }
  return {
    category: comment.category,
    confidence: comment.confidence,
    language: comment.language,
  };
}
