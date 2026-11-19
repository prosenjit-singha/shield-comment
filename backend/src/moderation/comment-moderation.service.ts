import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  dhakaDayKey,
  type DailyCommentStatsDelta,
  incrementDailyCommentStats,
} from '../comments/comments.queries.js';
import { CreditService } from '../credits/credit.service.js';
import type { Database } from '../db/database.js';
import type { DailyCommentCounter } from '../db/schema/comments.js';
import {
  type ClassifierInput,
  classificationCreditCost,
} from './classifier-input.js';
import type { ModerateCommentTarget } from './comment-moderation.job.js';
import {
  findAutoActionFlags,
  lockModerationComment,
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
  type ModerationDecision,
} from './moderation-decision.js';
import {
  ModerationPolicyService,
  workspacePlanFeatures,
} from './moderation-policy.service.js';
import {
  type CommentStatus,
  MODERATION_CATEGORY_KEYS,
  type ModerationStage,
} from './moderation.constants.js';
import {
  type ModerationPolicy,
  recordDailyAiUsage,
} from './moderation.queries.js';
import { PostContextService } from './post-context.service.js';

/** What one `moderate-comment` job did (the job's return value; ids and codes only). */
export type ModerationResult =
  | { kind: 'skipped'; reason: ModerationWorkerSkip }
  | {
      kind: 'moderated';
      /** Classified in this run (`false` = a retry that only finished the Meta step). */
      classified: boolean;
      credits: number;
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

type Prepared =
  | { kind: 'done'; result: ModerationResult }
  | { kind: 'work'; comment: ModerationComment };

/**
 * One comment version through moderation (M5-T12; D2/D3/D4/D6/D7/D8/D11/D13/D15).
 *
 * tx1 (`FOR UPDATE`): version + stage check, D13/D10 skips → policy + D8 context (Graph caption
 * outside any tx) → `CreditService.reserve(cost)` (refused → `SKIPPED credits_exhausted`) →
 * `classify()` (no tx) → tx2: classification + `credits_charged` + counts; when Meta must act the
 * stage becomes `act` → executor (Graph outside any tx) → tx3: status / stage / counts.
 *
 * Idempotency: `comments.moderation_stage` + `edited_at` are the version marker. A duplicate job or
 * a retry after success finds the stage cleared (`already_moderated`); a retry after a failed Meta
 * step finds `act` and only acts (no second AI call, no second charge). Credits are given back
 * (`release`, same `at` as the reserve) when the AI call produced no tokens. Logs ids, kinds and
 * counts only: never comment text, captions, Page names or replies.
 */
@Injectable()
export class CommentModerationService {
  private readonly logger = new Logger('CommentModeration');
  /** D7: one "out of credits" warning per workspace per Dhaka day (per process). */
  private readonly creditWarnings = new Map<string, string>();

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly policies: ModerationPolicyService,
    private readonly postContext: PostContextService,
    private readonly credits: CreditService,
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

    if (comment.moderationStage === 'act') {
      const stored = storedClassification(comment);
      if (stored) {
        return this.act(comment, policy, stored, 0, false, attempt, now);
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
    const cost = classificationCreditCost(input);
    if (cost === 0) {
      // `preClassifySkip` already refused blank text; kept as a guard.
      await this.db.transaction((tx) =>
        this.finishSkipped(tx, comment, 'classify', 'no_text', now()),
      );
      return { kind: 'skipped', reason: 'no_text' };
    }

    const reservedAt = now();
    const reserved = await this.credits.reserve(
      comment.workspaceId,
      cost,
      reservedAt,
    );
    if (!reserved) {
      await this.db.transaction((tx) =>
        this.finishSkipped(tx, comment, 'classify', 'credits_exhausted', now()),
      );
      this.warnOutOfCredits(comment.workspaceId, reservedAt);
      return { kind: 'skipped', reason: 'credits_exhausted' };
    }

    let result;
    try {
      result = await this.classifier.classify(input);
    } catch (error) {
      // Not an AI failure (e.g. the provider settings read failed): nothing reached the LLM.
      await this.credits.release(comment.workspaceId, cost, reservedAt);
      throw error;
    }

    if (!result.ok) {
      return this.classifyFailed(
        comment,
        target,
        result,
        cost,
        reservedAt,
        attempt,
        now,
      );
    }
    await this.recordUsage(result, cost, now());
    return this.classified(comment, policy, result, cost, attempt, now);
  }

  private async classifyFailed(
    comment: ModerationComment,
    target: ModerateCommentTarget,
    failure: ClassificationFailure,
    cost: number,
    reservedAt: Date,
    attempt: ModerationAttempt,
    now: () => Date,
  ): Promise<never> {
    // D7: a call that produced tokens is charged; one that never got an answer is given back.
    const charged = failure.usage !== undefined;
    if (!charged) {
      await this.credits.release(comment.workspaceId, cost, reservedAt);
    }
    await this.recordUsage(failure, charged ? cost : 0, now());
    const final = !failure.retryable || attempt.finalAttempt;
    if (charged || final) {
      await this.db.transaction(async (tx) => {
        const patch: ModerationStatePatch = charged ? { addCredits: cost } : {};
        if (final) {
          // D2: fail open. The stage stays `classify`, so the sweeper retries within 24 h.
          const status = statusWhenUnfinished(comment.status, 'FAILED');
          patch.status = status;
          if (status === 'FAILED') patch.statusReason = failure.kind;
        }
        const applied = await updateModerationState(
          tx,
          { ...target, stage: 'classify' },
          patch,
          now(),
        );
        if (applied && final)
          await this.count(tx, comment, { failed: 1 }, now());
      });
    }
    this.logger.warn(
      `Comment ${comment.id} (workspace ${comment.workspaceId}): classification failed (${failure.kind}, attempts ${failure.attempts}, credits ${charged ? cost : 0}${final ? ', final' : ', will retry'})`,
    );
    throw new ModerationStepError('classify', failure.kind, failure.retryable);
  }

  /** tx2: store the classification and decide; finish here when Meta has nothing to do. */
  private async classified(
    comment: ModerationComment,
    policy: ModerationPolicy,
    result: ClassificationSuccess,
    cost: number,
    attempt: ModerationAttempt,
    now: () => Date,
  ): Promise<ModerationResult> {
    const plan = await workspacePlanFeatures(this.db, comment.workspaceId);
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
        stage: 'classify' as const,
      };
      if (
        !current ||
        !sameVersion(current.editedAt, comment.editedAt) ||
        current.moderationStage !== 'classify'
      ) {
        // A newer edit (its own job classifies it) or another run finished first: the call
        // happened, so the charge stays on the comment.
        await updateModerationState(tx, version, { addCredits: cost }, at);
        return null;
      }
      const flags = await findAutoActionFlags(
        tx,
        comment.workspaceId,
        comment.id,
      );
      const decision = decideAction(policy, result, plan, {
        status: current.status,
        overriddenAt: current.overriddenAt,
        deletedAt: current.deletedAt,
        ...flags,
      });
      const metaSkip =
        needsMeta(decision) && current.connectionStatus !== 'ACTIVE'
          ? 'connection_needs_reauth'
          : null;
      const patch: ModerationStatePatch = {
        addCredits: cost,
        classification: {
          category: result.category,
          confidence: result.confidence,
          reasoning: result.reasoning,
          language: result.language,
          classifiedAt: at,
          aiProvider: result.provider,
          model: result.model,
          promptVersion: result.promptVersion,
          contextLevel: result.contextLevel,
        },
      };
      if (metaSkip !== null) {
        // D13: classified, the Meta action is skipped; visible comments wait for a human.
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
          statusReason: decisionStatusReason(decision),
        });
      }
      await updateModerationState(tx, version, patch, at);
      await this.count(
        tx,
        current,
        { classified: 1, [MODERATION_CATEGORY_KEYS[result.category]]: 1 },
        at,
      );
      return { current, decision, metaSkip };
    });

    this.logger.log(
      `Comment ${comment.id} (workspace ${comment.workspaceId}): classified ${result.category} (${result.confidence}, ${result.contextLevel}, credits ${cost})${stored ? ` → ${stored.decision.action}` : ' → newer version, not applied'}`,
    );
    if (!stored) return { kind: 'skipped', reason: 'stale_version' };
    const { current, decision, metaSkip } = stored;
    if (metaSkip !== null || !needsMeta(decision)) {
      return {
        kind: 'moderated',
        classified: true,
        credits: cost,
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
      policy,
      result,
      cost,
      true,
      attempt,
      now,
      decision,
    );
  }

  /**
   * The Meta step (stage `act`): the main action, then the D6 reply. Graph calls run in the
   * executor, outside any transaction; tx3 records the outcome.
   */
  private async act(
    comment: ModerationComment,
    policy: ModerationPolicy,
    classification: DecisionClassification,
    credits: number,
    classified: boolean,
    attempt: ModerationAttempt,
    now: () => Date,
    decided?: ModerationDecision,
  ): Promise<ModerationResult> {
    const decision =
      decided ??
      decideAction(
        policy,
        classification,
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
        classified,
        credits,
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
      statusReason: decisionStatusReason(decision),
    });
  }

  /**
   * Writes a skip: stage cleared; `SKIPPED` + reason (D7/D13), except for a human-stamped comment
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
    credits: number,
    at: Date,
  ): Promise<void> {
    if (!result.provider || !result.model) return;
    const calls = result.ok || result.attempts > 0 ? 1 : 0;
    try {
      await recordDailyAiUsage(this.db, {
        day: dhakaDayKey(at),
        provider: result.provider,
        model: result.model,
        calls,
        inputTokens: result.usage?.promptTokens ?? 0,
        outputTokens: result.usage?.completionTokens ?? 0,
        credits,
        latencyMs: result.latencyMs,
        ...(!result.ok && calls > 0 && { failures: { [result.kind]: 1 } }),
      });
    } catch (error) {
      this.logger.warn(
        `AI usage not recorded (${error instanceof Error ? error.name : 'unknown error'})`,
      );
    }
  }

  private warnOutOfCredits(workspaceId: string, at: Date): void {
    const day = dhakaDayKey(at);
    if (this.creditWarnings.get(workspaceId) === day) return;
    this.creditWarnings.set(workspaceId, day);
    this.logger.warn(
      `Workspace ${workspaceId}: monthly AI credits used up; comments are skipped (credits_exhausted) until the next month or a plan change`,
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
