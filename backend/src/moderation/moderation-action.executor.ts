import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import { MetaGraphClient } from '../meta/meta-graph.client.js';
import {
  MetaGraphError,
  type MetaGraphErrorKind,
} from '../meta/meta-graph.errors.js';
import { markConnectionNeedsReauth } from '../meta/page-subscription.queries.js';
import {
  type ActionTarget,
  applyActionToComment,
  findActionTarget,
  stampCommentOverride,
  statusAfterAction,
} from './moderation-action.queries.js';
import type { CommentStatus } from './moderation.constants.js';
import {
  completeModerationAction,
  findAutoReplyAction,
  insertModerationAction,
  type ModerationActionOutcome,
  type ModerationActionRow,
  reopenModerationAction,
} from './moderation.queries.js';

/** Who acts: the moderation worker (`AUTO`, actor = system) or a workspace member (`USER`). */
export type ModerationActor =
  { source: 'AUTO' } | { source: 'USER'; userId: string };

/** What to do. A reply carries its text (chosen by `decideAction`, D6, or typed by a member). */
export type ModerationActionRequest =
  | { action: 'HIDE' | 'UNHIDE' | 'DELETE' }
  | { action: 'REPLY'; replyText: string };

export type ExecuteModerationActionInput = {
  workspaceId: string;
  /** `comments.id` (not the Meta comment id). */
  commentId: string;
} & ModerationActor &
  ModerationActionRequest;

/** Why nothing was sent to Meta (no `moderation_actions` row was written either). */
export const MODERATION_SKIP_REASONS = [
  /** No such comment in this workspace (another workspace's id included). */
  'comment_not_found',
  /** Deleted on Meta or by us: never acted on, never replied to (D6). */
  'comment_deleted',
  /** AUTO on a human-stamped comment (D10/D11). */
  'human_override',
  /** The comment's Page was disconnected (`social_page_id` null, M4-T9). */
  'page_disconnected',
  /** The Page is switched off. */
  'page_inactive',
  /** The workspace's Meta connection is missing or not `ACTIVE`. */
  'connection_inactive',
  /** Meta app or token cipher env unset. */
  'meta_not_configured',
  /** The Page has no stored token. */
  'page_token_missing',
  /** The stored Page token can't be decrypted (re-connect needed). */
  'page_token_undecryptable',
  /** AUTO reply: one is already sent or in flight (D6: never twice). */
  'already_replied',
] as const;
export type ModerationSkipReason = (typeof MODERATION_SKIP_REASONS)[number];

export type ModerationActionResult =
  | { outcome: 'skipped'; reason: ModerationSkipReason }
  | {
      outcome: 'succeeded';
      /** `moderation_actions.id`. */
      actionId: string;
      /** The comment status the action left (`null` for REPLY: unchanged). */
      commentStatus: CommentStatus | null;
      /** Meta id of the posted reply (REPLY), when Meta returned one. */
      replyCommentId: string | null;
      /** DELETE of a comment Meta no longer has (`not_found`): counted as done. */
      alreadyGone: boolean;
    }
  | {
      outcome: 'failed';
      actionId: string;
      errorKind: MetaGraphErrorKind | 'internal_error';
      /** `rate_limited` / `transient` / `network`: try again later (BullMQ backoff). */
      retryable: boolean;
      /** This failure moved the connection `ACTIVE` → `NEEDS_REAUTH` (`token_invalid`). */
      connectionMarked: boolean;
    };

const UNIQUE_VIOLATION = '23505';

function pgCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown }).cause ?? error;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

type Opened =
  | { kind: 'opened'; row: ModerationActionRow }
  | { kind: 'skipped'; reason: ModerationSkipReason };

/**
 * Applies one moderation action to a Meta comment (M5-T9; decisions D3/D6/D10/D11).
 *
 * Flow: read comment + Page + connection (scoped by `workspace_id`) → skip rules (typed result, no
 * Graph call, no row) → decrypt the Page token → short tx: `moderation_actions` row `PENDING`
 * (+ USER stamp `overridden_at`) → Graph call **outside** any transaction → short tx: row
 * `SUCCEEDED`/`FAILED` + comment status. `token_invalid` → connection `NEEDS_REAUTH`.
 *
 * Idempotency: HIDE/UNHIDE are safe to repeat (one new log row per call); DELETE of a deleted
 * comment is skipped, and `not_found` on DELETE counts as done. An AUTO reply is unique per comment:
 * a FAILED one is reopened and retried, a PENDING/SUCCEEDED one is never sent again.
 * Logs ids, actions and kinds only (never comment or reply text, never tokens).
 */
@Injectable()
export class ModerationActionExecutor {
  private readonly logger = new Logger(ModerationActionExecutor.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly graph: MetaGraphClient,
    private readonly cipher: TokenCipherService,
  ) {}

  /** Never throws for Graph failures or skips (they are results); DB errors propagate. */
  async execute(
    input: ExecuteModerationActionInput,
    now: () => Date = () => new Date(),
  ): Promise<ModerationActionResult> {
    if (input.action === 'REPLY' && input.replyText.trim().length === 0) {
      throw new Error('replyText must not be empty');
    }
    const target = await findActionTarget(
      this.db,
      input.workspaceId,
      input.commentId,
    );
    const skip = this.skipReason(input, target);
    if (skip !== null || !target) {
      return this.skipped(input, skip ?? 'comment_not_found');
    }
    // `skipReason` returned null, so the Page exists with a token.
    const page = target.page!;
    const ciphertext = page.encryptedPageAccessToken!;
    const token = this.decrypt(target, page.pageId, ciphertext);
    if (token === null) return this.skipped(input, 'page_token_undecryptable');

    const opened = await this.open(input, now());
    if (opened.kind === 'skipped') return this.skipped(input, opened.reason);
    const action = opened.row;

    let outcome: ModerationActionOutcome;
    let graphError: MetaGraphError | null = null;
    let alreadyGone = false;
    try {
      const replyCommentId = await this.callGraph(input, target, token);
      outcome = { state: 'SUCCEEDED', replyCommentId };
    } catch (error) {
      if (!(error instanceof MetaGraphError)) {
        await this.complete(
          input,
          action.id,
          {
            state: 'FAILED',
            errorKind: 'internal_error',
          },
          now(),
        );
        throw error;
      }
      graphError = error;
      if (error.kind === 'not_found' && input.action === 'DELETE') {
        alreadyGone = true;
        outcome = { state: 'SUCCEEDED' };
      } else if (
        error.kind === 'unexpected_response' &&
        input.action === 'REPLY'
      ) {
        // Meta answered 2xx: the reply was most likely posted. Never risk a second one (D6).
        outcome = { state: 'SUCCEEDED' };
      } else {
        outcome = { state: 'FAILED', errorKind: error.kind };
      }
    }

    await this.complete(input, action.id, outcome, now());

    if (outcome.state === 'SUCCEEDED') {
      this.logger.log(
        `Comment ${target.id} (workspace ${target.workspaceId}): ${input.source} ${input.action} succeeded (action ${action.id}${alreadyGone ? ', already gone' : ''}${graphError ? `, ${graphError.kind}` : ''})`,
      );
      return {
        outcome: 'succeeded',
        actionId: action.id,
        commentStatus: statusAfterAction(input.action),
        replyCommentId: outcome.replyCommentId ?? null,
        alreadyGone,
      };
    }

    const error = graphError!;
    this.logger.warn(
      `Comment ${target.id} (workspace ${target.workspaceId}): ${input.source} ${input.action} failed (action ${action.id}, ${error.kind}${error.code === undefined ? '' : ` #${error.code}`})`,
    );
    let connectionMarked = false;
    if (error.kind === 'token_invalid') {
      connectionMarked = await markConnectionNeedsReauth(this.db, {
        workspaceId: target.workspaceId,
        pageRowId: page.id,
        observedPageToken: ciphertext,
        now: now(),
      });
      if (connectionMarked) {
        this.logger.warn(
          `Workspace ${target.workspaceId}: Meta connection ACTIVE → NEEDS_REAUTH (Page token rejected)`,
        );
      }
    }
    return {
      outcome: 'failed',
      actionId: action.id,
      errorKind: error.kind,
      retryable: error.retryable,
      connectionMarked,
    };
  }

  /** `null` = act. Order: comment → human stamp → Page → connection → config → token. */
  private skipReason(
    input: ExecuteModerationActionInput,
    target: ActionTarget | undefined,
  ): ModerationSkipReason | null {
    if (!target) return 'comment_not_found';
    if (target.deletedAt !== null || target.status === 'DELETED') {
      return 'comment_deleted';
    }
    if (input.source === 'AUTO' && target.overriddenAt !== null) {
      return 'human_override';
    }
    if (target.page === null) return 'page_disconnected';
    if (!target.page.isActive) return 'page_inactive';
    if (target.connectionStatus !== 'ACTIVE') return 'connection_inactive';
    if (!this.graph.enabled || !this.cipher.isConfigured) {
      return 'meta_not_configured';
    }
    if (target.page.encryptedPageAccessToken === null) {
      return 'page_token_missing';
    }
    return null;
  }

  private decrypt(
    target: ActionTarget,
    pageId: string,
    ciphertext: string,
  ): string | null {
    try {
      return this.cipher.decrypt(
        ciphertext,
        tokenCipherContext('meta_page_token', target.workspaceId, pageId),
      );
    } catch {
      this.logger.warn(
        `Comment ${target.id} (workspace ${target.workspaceId}): Page token cannot be decrypted`,
      );
      return null;
    }
  }

  /**
   * One short transaction: the `PENDING` log row (an AUTO reply reuses its FAILED row, never a
   * PENDING/SUCCEEDED one) and, for a member's action, the D10 stamp.
   */
  private async open(
    input: ExecuteModerationActionInput,
    at: Date,
  ): Promise<Opened> {
    try {
      return await this.db.transaction(async (tx): Promise<Opened> => {
        let row: ModerationActionRow | undefined;
        if (input.action === 'REPLY' && input.source === 'AUTO') {
          const existing = await findAutoReplyAction(
            tx,
            input.workspaceId,
            input.commentId,
          );
          if (existing && existing.state !== 'FAILED') {
            return { kind: 'skipped', reason: 'already_replied' };
          }
          row = existing
            ? await reopenModerationAction(
                tx,
                input.workspaceId,
                existing.id,
                at,
              )
            : await insertModerationAction(tx, {
                workspaceId: input.workspaceId,
                commentId: input.commentId,
                action: 'REPLY',
                source: 'AUTO',
              });
          // A concurrent retry reopened it first.
          if (!row && existing) {
            return { kind: 'skipped', reason: 'already_replied' };
          }
        } else {
          row = await insertModerationAction(
            tx,
            input.source === 'USER'
              ? {
                  workspaceId: input.workspaceId,
                  commentId: input.commentId,
                  action: input.action,
                  source: 'USER',
                  userId: input.userId,
                }
              : {
                  workspaceId: input.workspaceId,
                  commentId: input.commentId,
                  action: input.action,
                  source: 'AUTO',
                },
          );
          if (row && input.source === 'USER') {
            await stampCommentOverride(
              tx,
              input.workspaceId,
              input.commentId,
              at,
            );
          }
        }
        if (!row) return { kind: 'skipped', reason: 'comment_not_found' };
        return { kind: 'opened', row };
      });
    } catch (error) {
      // Two AUTO replies raced on `moderation_actions_one_auto_reply`: the other one sends.
      if (
        input.action === 'REPLY' &&
        input.source === 'AUTO' &&
        pgCode(error) === UNIQUE_VIOLATION
      ) {
        return { kind: 'skipped', reason: 'already_replied' };
      }
      throw error;
    }
  }

  /** The Graph call (no transaction is open here). Returns the reply id for REPLY. */
  private async callGraph(
    input: ExecuteModerationActionInput,
    target: ActionTarget,
    token: string,
  ): Promise<string | undefined> {
    switch (input.action) {
      case 'HIDE':
        await this.graph.hideComment(
          target.platform,
          target.metaCommentId,
          token,
        );
        return undefined;
      case 'UNHIDE':
        await this.graph.unhideComment(
          target.platform,
          target.metaCommentId,
          token,
        );
        return undefined;
      case 'DELETE':
        await this.graph.deleteComment(target.metaCommentId, token);
        return undefined;
      case 'REPLY': {
        const reply = await this.graph.replyToComment(
          target.platform,
          target.metaCommentId,
          input.replyText,
          token,
        );
        return reply.id;
      }
    }
  }

  /** One short transaction: finish the log row and mirror a success on the comment. */
  private async complete(
    input: ExecuteModerationActionInput,
    actionId: string,
    outcome: ModerationActionOutcome,
    at: Date,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await completeModerationAction(
        tx,
        input.workspaceId,
        actionId,
        outcome,
        at,
      );
      if (outcome.state === 'SUCCEEDED') {
        await applyActionToComment(
          tx,
          input.workspaceId,
          input.commentId,
          input.action,
          at,
        );
      }
    });
  }

  private skipped(
    input: ExecuteModerationActionInput,
    reason: ModerationSkipReason,
  ): ModerationActionResult {
    this.logger.debug(
      `Comment ${input.commentId} (workspace ${input.workspaceId}): ${input.source} ${input.action} skipped (${reason})`,
    );
    return { outcome: 'skipped', reason };
  }
}
