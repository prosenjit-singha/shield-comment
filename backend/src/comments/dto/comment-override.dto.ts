import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  Length,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import {
  AUTO_REPLY_TEXT_MAX_CHARS,
  MODERATION_ACTION_TYPES,
  type ModerationActionType,
} from '../../moderation/moderation.constants.js';

/**
 * `POST /api/workspaces/:workspaceId/comments/:commentId/override` (M6-T4; Module 6 D7/D8).
 * `replyText` is required for `REPLY` (trimmed, 1–500 chars) and refused with any other action.
 */
export class CommentOverrideDto {
  @IsIn(MODERATION_ACTION_TYPES)
  action!: ModerationActionType;

  @ValidateIf(
    (o: CommentOverrideDto) =>
      o.action === 'REPLY' || o.replyText !== undefined,
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateBy({
    name: 'replyTextOnlyForReply',
    validator: {
      validate: (_value: unknown, args) =>
        (args?.object as CommentOverrideDto | undefined)?.action === 'REPLY',
      defaultMessage: () => 'replyText is only allowed with action REPLY',
    },
  })
  @IsString()
  @Length(1, AUTO_REPLY_TEXT_MAX_CHARS)
  replyText?: string;
}
