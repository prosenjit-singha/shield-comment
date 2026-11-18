import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../db/database.js';
import type { CommentIngestJobData } from '../webhooks/comment-ingest.job.js';
import {
  applyCommentEdit,
  findIngestRoute,
  markCommentDeleted,
} from './comment-ingest.queries.js';
import {
  decideIngestRoute,
  type IngestDropReason,
  type IngestRoute,
  ingestEventInstant,
  ingestRoutingId,
} from './comment-ingest.rules.js';
import {
  type CommentsExecutor,
  type DailyCommentStatsDelta,
  dhakaDayKey,
  incrementDailyCommentStats,
  insertComment,
  insertWebhookEvent,
  markWebhookEventProcessed,
} from './comments.queries.js';

/**
 * What a change did to the comment row:
 * - `created`: new row (`add`, or `edited` before its `add`: the edit is stored as the comment);
 * - `updated`: `edited` applied (`applied: false` = an older edit arrived after a newer one);
 * - `deleted`: `remove` set `deleted_at`;
 * - `placeholder`: `remove` before its `add`: a deleted row without text, so a late `add` can't
 *   bring the comment back;
 * - `unchanged`: nothing to write (a late `add` for a stored comment, or the comment id belongs to
 *   another workspace, e.g. the Page moved after a disconnect).
 */
export type IngestAction =
  'created' | 'updated' | 'deleted' | 'placeholder' | 'unchanged';

export type IngestOutcome =
  | { kind: 'dropped'; reason: IngestDropReason }
  | { kind: 'duplicate'; workspaceId: string }
  | {
      kind: 'stored';
      workspaceId: string;
      action: IngestAction;
      /** `comments.id` (absent for `unchanged`). */
      commentRowId?: string;
      /** The comment has new text to moderate (Module 5 hand-off). */
      moderate: boolean;
    };

type StoreResult = {
  action: IngestAction;
  commentRowId?: string;
  moderate: boolean;
  counts: Pick<DailyCommentStatsDelta, 'received' | 'edited' | 'removed'>;
};

/**
 * Applies one `comment-ingest` job (M4-T5; Module 4 D2/D4/D9 + out-of-order decision
 * 2026-11-18) in **one transaction**: route → `webhook_events` (duplicate `event_id` = done) →
 * verb → daily counts → `processed_at`. Counts: `received` +1 whenever a comment row with content
 * is created (`add`, or an `edited` that arrives first), `edited` +1 per stored edit event,
 * `removed` +1 per stored remove event; `unchanged` moves nothing. Errors propagate (the worker
 * splits retryable from permanent ones).
 */
@Injectable()
export class CommentIngestService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  ingest(
    data: CommentIngestJobData,
    now: Date = new Date(),
  ): Promise<IngestOutcome> {
    return this.db.transaction(async (tx) => {
      const decision = decideIngestRoute(
        await findIngestRoute(tx, data.platform, ingestRoutingId(data)),
      );
      if (decision.kind === 'drop') {
        return { kind: 'dropped', reason: decision.reason };
      }
      const { route } = decision;
      const isNew = await insertWebhookEvent(tx, {
        eventId: data.eventId,
        workspaceId: route.workspaceId,
        payloadHash: data.payloadHash,
      });
      if (!isNew) return { kind: 'duplicate', workspaceId: route.workspaceId };

      const at = ingestEventInstant(data, now);
      const result = await this.store(tx, route, data, at);
      if (
        (result.counts.received ?? 0) +
          (result.counts.edited ?? 0) +
          (result.counts.removed ?? 0) >
        0
      ) {
        await incrementDailyCommentStats(tx, {
          workspaceId: route.workspaceId,
          pageId: route.pageId,
          platform: data.platform,
          day: dhakaDayKey(at),
          ...result.counts,
        });
      }
      await markWebhookEventProcessed(tx, route.workspaceId, data.eventId);
      return {
        kind: 'stored',
        workspaceId: route.workspaceId,
        action: result.action,
        ...(result.commentRowId ? { commentRowId: result.commentRowId } : {}),
        moderate: result.moderate,
      };
    });
  }

  private async store(
    tx: CommentsExecutor,
    route: IngestRoute,
    data: CommentIngestJobData,
    at: Date,
  ): Promise<StoreResult> {
    const unchanged: StoreResult = {
      action: 'unchanged',
      moderate: false,
      counts: {},
    };
    const newRow = (extra: { editedAt?: Date; deletedAt?: Date }) =>
      insertComment(tx, {
        commentId: data.commentId,
        workspaceId: route.workspaceId,
        socialPageId: route.socialPageId,
        platform: data.platform,
        postId: data.postId,
        authorId: data.authorId,
        authorName: data.authorName,
        message: extra.deletedAt ? null : data.message,
        rawPayload: data.rawPayload,
        status: 'PENDING',
        ...extra,
      });

    switch (data.verb) {
      case 'add': {
        // An existing row (from an earlier `add`, an `edited` that came first, or a `remove`
        // placeholder) is never overwritten: a late `add` must not undo an edit or a delete.
        const row = await newRow({});
        if (!row) return unchanged;
        return {
          action: 'created',
          commentRowId: row.id,
          moderate: true,
          counts: { received: 1 },
        };
      }
      case 'edited': {
        const edit = { message: data.message, rawPayload: data.rawPayload, at };
        let updated = await applyCommentEdit(
          tx,
          route.workspaceId,
          data.commentId,
          edit,
        );
        if (!updated) {
          // No row yet (out-of-order delivery or the `add` was dropped): store the edit as the
          // comment, so a scam edit still gets moderated (decision 2026-11-18).
          const row = await newRow({ editedAt: at });
          if (row) {
            return {
              action: 'created',
              commentRowId: row.id,
              moderate: true,
              counts: { received: 1, edited: 1 },
            };
          }
          // A concurrent job created it meanwhile (ON CONFLICT waited for it) → update that row;
          // still nothing → the comment id belongs to another workspace.
          updated = await applyCommentEdit(
            tx,
            route.workspaceId,
            data.commentId,
            edit,
          );
          if (!updated) return unchanged;
        }
        return {
          action: 'updated',
          commentRowId: updated.id,
          moderate: updated.applied && updated.deletedAt === null,
          counts: { edited: 1 },
        };
      }
      case 'remove': {
        let removed = await markCommentDeleted(
          tx,
          route.workspaceId,
          data.commentId,
          at,
        );
        if (!removed) {
          const row = await newRow({ deletedAt: at });
          if (row) {
            return {
              action: 'placeholder',
              commentRowId: row.id,
              moderate: false,
              counts: { removed: 1 },
            };
          }
          removed = await markCommentDeleted(
            tx,
            route.workspaceId,
            data.commentId,
            at,
          );
          if (!removed) return unchanged;
        }
        return {
          action: 'deleted',
          commentRowId: removed.id,
          moderate: false,
          counts: { removed: 1 },
        };
      }
    }
  }
}
