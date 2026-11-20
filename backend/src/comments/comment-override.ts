import {
  BadGatewayException,
  ConflictException,
  type HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  ExecuteModerationActionInput,
  ModerationActionResult,
  ModerationSkipReason,
} from '../moderation/moderation-action.executor.js';
import type { CommentOverrideDto } from './dto/comment-override.dto.js';

/**
 * Manual override (M6-T4): request → executor input, executor result → HTTP error. Both pure.
 * 409 `code` = the skip reason in upper case (`COMMENT_DELETED`, `PAGE_DISCONNECTED`, …);
 * 503 `META_NOT_CONFIGURED`; Graph failure → 502 `META_ACTION_FAILED` `details { errorKind, retryable }`.
 */
export const COMMENT_OVERRIDE_ERROR_CODES = {
  metaNotConfigured: 'META_NOT_CONFIGURED',
  metaActionFailed: 'META_ACTION_FAILED',
} as const;

/** Never empty: `CommentOverrideDto` already required a REPLY's text. */
export function toOverrideInput(
  workspaceId: string,
  commentId: string,
  userId: string,
  dto: CommentOverrideDto,
): ExecuteModerationActionInput {
  const actor = { workspaceId, commentId, source: 'USER', userId } as const;
  return dto.action === 'REPLY'
    ? { ...actor, action: 'REPLY', replyText: dto.replyText ?? '' }
    : { ...actor, action: dto.action };
}

/** 409 messages per skip reason (the UI translates by `code`). */
const CONFLICT_MESSAGES: Record<
  Exclude<ModerationSkipReason, 'comment_not_found' | 'meta_not_configured'>,
  string
> = {
  comment_deleted: 'This comment was deleted.',
  human_override: 'A member already acted on this comment.',
  page_disconnected: "This comment's Page is disconnected.",
  page_inactive: "This comment's Page is switched off.",
  connection_inactive: 'Reconnect Facebook to act on comments.',
  page_token_missing: 'Reconnect Facebook to act on this Page.',
  page_token_undecryptable: 'Reconnect Facebook to act on this Page.',
  already_replied: 'A reply was already sent.',
  comment_hidden: 'This comment is hidden. Unhide it instead.',
};

/** `null` = succeeded (answer with the updated feed item). */
export function overrideError(
  result: ModerationActionResult,
): HttpException | null {
  if (result.outcome === 'succeeded') return null;
  if (result.outcome === 'failed') {
    return new BadGatewayException({
      message: 'Meta did not accept the action. Try again later.',
      error: 'Bad Gateway',
      code: COMMENT_OVERRIDE_ERROR_CODES.metaActionFailed,
      details: { errorKind: result.errorKind, retryable: result.retryable },
    });
  }
  switch (result.reason) {
    case 'comment_not_found':
      return new NotFoundException('Comment not found');
    case 'meta_not_configured':
      return new ServiceUnavailableException({
        message: 'Meta is not configured on this server.',
        error: 'Service Unavailable',
        code: COMMENT_OVERRIDE_ERROR_CODES.metaNotConfigured,
      });
    default:
      return new ConflictException({
        message: CONFLICT_MESSAGES[result.reason],
        error: 'Conflict',
        code: result.reason.toUpperCase(),
      });
  }
}
