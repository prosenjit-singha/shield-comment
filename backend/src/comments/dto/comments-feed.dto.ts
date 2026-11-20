import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DATE_KEY } from '../../admin/dashboard-range.js';
import {
  COMMENT_PLATFORMS,
  COMMENT_STATUSES,
  type CommentPlatform,
  type CommentStatus,
} from '../../db/schema/index.js';
import {
  type CommentLanguage,
  MODERATION_CATEGORIES,
  type ModerationActionSource,
  type ModerationActionState,
  type ModerationActionType,
  type ModerationCategory,
} from '../../moderation/moderation.constants.js';

export const FEED_PAGE_MAX = 50;
export const FEED_PAGE_DEFAULT = 20;
export const FEED_SEARCH_MAX = 100;
/** An encoded cursor is ~60 chars; anything longer is not one of ours. */
export const FEED_CURSOR_MAX = 200;

/** A date-time with an explicit offset (`…Z` / `…+06:00`): `since` is an instant, never a day. */
export const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * `GET /api/workspaces/:workspaceId/comments` (M6-T3; D1/D7 answered 2026-11-20). Every filter is
 * optional and they combine with AND. `pageId` = our `social_pages.id` (the `page.id` of an item),
 * not the Meta Page id. `from`/`to` = inclusive Asia/Dhaka days. `since` = only comments created
 * after that instant (D1 polling). `cursor` = the previous page's `nextCursor` (opaque).
 */
export class CommentsFeedQueryDto {
  @IsOptional()
  @IsIn(COMMENT_STATUSES)
  status?: CommentStatus;

  @IsOptional()
  @IsIn(MODERATION_CATEGORIES)
  category?: ModerationCategory;

  @IsOptional()
  @IsIn(COMMENT_PLATFORMS)
  platform?: CommentPlatform;

  @IsOptional()
  @IsUUID()
  pageId?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_KEY, { message: 'from must be a YYYY-MM-DD date' })
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_KEY, { message: 'to must be a YYYY-MM-DD date' })
  @IsISO8601({ strict: true })
  to?: string;

  /** Case-insensitive substring of the message; trimmed, blank = no search. */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(FEED_SEARCH_MAX)
  q?: string;

  @IsOptional()
  @IsString()
  @Matches(ISO_INSTANT, {
    message: 'since must be an ISO 8601 date-time with offset',
  })
  @IsISO8601({ strict: true })
  since?: string;

  @IsOptional()
  @IsString()
  @MaxLength(FEED_CURSOR_MAX)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FEED_PAGE_MAX)
  limit: number = FEED_PAGE_DEFAULT;
}

/** The latest `moderation_actions` row of a comment; `at` = completion, else creation. */
export interface CommentFeedAction {
  action: ModerationActionType;
  source: ModerationActionSource;
  state: ModerationActionState;
  at: Date;
}

/** A feed row: never the raw payload, the FB/IG author id or any token. */
export interface CommentFeedItem {
  id: string;
  platform: CommentPlatform;
  /** `null` once the Page was disconnected. */
  page: { id: string; name: string } | null;
  postId: string;
  authorName: string | null;
  message: string | null;
  status: CommentStatus;
  statusReason: string | null;
  category: ModerationCategory | null;
  confidence: number | null;
  language: CommentLanguage | null;
  reasoning: string | null;
  ruleMatch: string | null;
  overriddenAt: Date | null;
  editedAt: Date | null;
  createdAt: Date;
  lastAction: CommentFeedAction | null;
}

export interface CommentsFeedResponse {
  items: CommentFeedItem[];
  /** Pass as `cursor` for the next (older) page; `null` = no more. */
  nextCursor: string | null;
}
