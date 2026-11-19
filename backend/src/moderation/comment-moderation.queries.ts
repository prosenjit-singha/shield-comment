import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  type CommentPlatform,
  comments,
  type MetaConnectionStatus,
  metaConnections,
  moderationActions,
  socialPages,
} from '../db/schema/index.js';
import type {
  CommentLanguage,
  CommentStatus,
  ContextLevel,
  ModerationCategory,
  ModerationStage,
} from './moderation.constants.js';
import type { AiProvider } from '../ai-gateway/ai-provider.js';

/**
 * Reads and writes of the moderation worker (M5-T12). Every query is scoped by `workspace_id`,
 * except `findSweepCandidates` (the D2 sweeper looks across workspaces, like the raw-payload
 * purge; it returns ids only and every job it enqueues is scoped again).
 */

export type ModerationWorkerExecutor = Pick<
  Database,
  'select' | 'update' | 'insert'
>;

/** One comment as the worker sees it (+ its Page and the workspace connection). */
export interface ModerationComment {
  id: string;
  workspaceId: string;
  platform: CommentPlatform;
  postId: string;
  message: string | null;
  rawPayload: Record<string, unknown> | null;
  status: CommentStatus;
  editedAt: Date | null;
  deletedAt: Date | null;
  overriddenAt: Date | null;
  moderationStage: ModerationStage | null;
  category: ModerationCategory | null;
  confidence: number | null;
  language: CommentLanguage | null;
  socialPageId: string | null;
  /** The Page (scoped to the workspace); `null` = orphaned or not this workspace's. */
  page: { metaPageId: string; isActive: boolean } | null;
  connectionStatus: MetaConnectionStatus | null;
}

/**
 * The comment row **locked** (`FOR UPDATE OF comments`) for the rest of the transaction, with its
 * Page and the workspace connection. `undefined` = no such comment in the workspace.
 */
export async function lockModerationComment(
  tx: ModerationWorkerExecutor,
  workspaceId: string,
  commentRowId: string,
): Promise<ModerationComment | undefined> {
  const [row] = await tx
    .select({
      id: comments.id,
      workspaceId: comments.workspaceId,
      platform: comments.platform,
      postId: comments.postId,
      message: comments.message,
      rawPayload: comments.rawPayload,
      status: comments.status,
      editedAt: comments.editedAt,
      deletedAt: comments.deletedAt,
      overriddenAt: comments.overriddenAt,
      moderationStage: comments.moderationStage,
      category: comments.category,
      confidence: comments.confidence,
      language: comments.language,
      socialPageId: comments.socialPageId,
      metaPageId: socialPages.pageId,
      pageIsActive: socialPages.isActive,
      connectionStatus: metaConnections.status,
    })
    .from(comments)
    .leftJoin(
      socialPages,
      and(
        eq(socialPages.id, comments.socialPageId),
        eq(socialPages.workspaceId, workspaceId),
      ),
    )
    .leftJoin(metaConnections, eq(metaConnections.workspaceId, workspaceId))
    .where(
      and(eq(comments.workspaceId, workspaceId), eq(comments.id, commentRowId)),
    )
    .for('update', { of: comments });
  if (!row) return undefined;
  const { metaPageId, pageIsActive, ...rest } = row;
  return {
    ...rest,
    page:
      metaPageId !== null && pageIsActive !== null
        ? { metaPageId, isActive: pageIsActive }
        : null,
  };
}

/** D6/D11 inputs of `decideAction` from the comment's `moderation_actions`. */
export interface AutoActionFlags {
  /** The last SUCCEEDED HIDE/UNHIDE is an AUTO HIDE (only then may the AI un-hide, D11). */
  hiddenByAi: boolean;
  /** An AUTO reply is sent or in flight (a FAILED one may be retried by the executor). */
  autoReplied: boolean;
}

export async function findAutoActionFlags(
  executor: Pick<Database, 'select'>,
  workspaceId: string,
  commentRowId: string,
): Promise<AutoActionFlags> {
  const scope = and(
    eq(moderationActions.workspaceId, workspaceId),
    eq(moderationActions.commentId, commentRowId),
  );
  const [lastVisibility] = await executor
    .select({
      action: moderationActions.action,
      source: moderationActions.source,
    })
    .from(moderationActions)
    .where(
      and(
        scope,
        eq(moderationActions.state, 'SUCCEEDED'),
        inArray(moderationActions.action, ['HIDE', 'UNHIDE']),
      ),
    )
    .orderBy(
      desc(moderationActions.completedAt),
      desc(moderationActions.createdAt),
      desc(moderationActions.id),
    )
    .limit(1);
  const [reply] = await executor
    .select({ state: moderationActions.state })
    .from(moderationActions)
    .where(
      and(
        scope,
        eq(moderationActions.action, 'REPLY'),
        eq(moderationActions.source, 'AUTO'),
      ),
    )
    .limit(1);
  return {
    hiddenByAi:
      lastVisibility?.action === 'HIDE' && lastVisibility.source === 'AUTO',
    autoReplied: reply !== undefined && reply.state !== 'FAILED',
  };
}

/** The stored classification (all-or-nothing columns, `comments_classification_complete`). */
export interface StoredClassification {
  category: ModerationCategory;
  confidence: number;
  reasoning: string;
  language: CommentLanguage;
  classifiedAt: Date;
  aiProvider: AiProvider;
  model: string;
  promptVersion: string;
  contextLevel: ContextLevel;
}

/** What a worker step writes on the comment (only the given keys change). */
export interface ModerationStatePatch {
  stage?: ModerationStage | null;
  status?: CommentStatus;
  statusReason?: string | null;
  classification?: StoredClassification;
  /** Credits to add to `credits_charged` (D7). */
  addCredits?: number;
}

/**
 * Applies a worker step to the comment, guarded by the version (`edited_at`) and the stage the
 * step started from: a newer edit (or another run that finished the stage) makes it a no-op for
 * everything but `addCredits`, which is always added (the AI call happened). `true` = the guarded
 * patch applied.
 */
export async function updateModerationState(
  tx: ModerationWorkerExecutor,
  target: {
    workspaceId: string;
    commentRowId: string;
    editedAt: Date | null;
    stage: ModerationStage;
  },
  patch: ModerationStatePatch,
  at: Date,
): Promise<boolean> {
  const scope = and(
    eq(comments.workspaceId, target.workspaceId),
    eq(comments.id, target.commentRowId),
  );
  const credits = patch.addCredits ?? 0;
  const set: Partial<typeof comments.$inferInsert> = { updatedAt: at };
  if (patch.stage !== undefined) set.moderationStage = patch.stage;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.statusReason !== undefined) set.statusReason = patch.statusReason;
  if (patch.classification) Object.assign(set, patch.classification);
  const rows = await tx
    .update(comments)
    .set({
      ...set,
      ...(credits > 0 && {
        creditsCharged: sql`${comments.creditsCharged} + ${credits}`,
      }),
    })
    .where(
      and(
        scope,
        target.editedAt === null
          ? sql`${comments.editedAt} is null`
          : eq(comments.editedAt, target.editedAt),
        eq(comments.moderationStage, target.stage),
      ),
    )
    .returning({ id: comments.id });
  if (rows.length > 0) return true;
  if (credits > 0) {
    await tx
      .update(comments)
      .set({
        creditsCharged: sql`${comments.creditsCharged} + ${credits}`,
        updatedAt: at,
      })
      .where(scope);
  }
  return false;
}

/** A comment the sweeper re-queues (ids + version only). */
export interface SweepCandidate {
  id: string;
  workspaceId: string;
  editedAt: Date | null;
}

/**
 * D2 sweeper: comments that still owe moderation (`moderation_stage` set) whose text is younger
 * than `since` and that nothing touched after `idleBefore`, oldest first. System-wide (no
 * workspace scope): served by `comments_moderation_stage_index`.
 */
export function findSweepCandidates(
  executor: Pick<Database, 'select'>,
  range: { since: Date; idleBefore: Date; limit: number },
): Promise<SweepCandidate[]> {
  const age = sql`coalesce(${comments.editedAt}, ${comments.createdAt})`;
  return executor
    .select({
      id: comments.id,
      workspaceId: comments.workspaceId,
      editedAt: comments.editedAt,
    })
    .from(comments)
    .where(
      and(
        isNotNull(comments.moderationStage),
        sql`${age} >= ${range.since}`,
        sql`${comments.updatedAt} < ${range.idleBefore}`,
      ),
    )
    .orderBy(asc(age))
    .limit(range.limit);
}
