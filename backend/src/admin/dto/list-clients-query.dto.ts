import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { workspaceStatus } from '../../db/schema/index.js';

export const CLIENTS_PAGE_MAX = 100;
export const CLIENTS_SEARCH_MAX = 100;

export const CLIENT_SORTS = ['newest', 'oldest', 'name'] as const;
export type ClientSort = (typeof CLIENT_SORTS)[number];

export const WORKSPACE_STATUSES = workspaceStatus.enumValues;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/**
 * A calendar date (`2026-11-18`, a whole UTC day) or a date-time with an explicit offset
 * (`2026-11-18T00:00:00+06:00`, `…Z`). Offset-less date-times are refused (server-time ambiguity);
 * ISO week/ordinal dates too.
 */
export const ISO_DATE_OR_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** `plan` filter value for workspaces without a plan (no seeded plan uses this slug). */
export const NO_PLAN = 'none';

/** A plan slug (same format as the `plans_slug_format` check) or `none`. */
export const PLAN_FILTER = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PLAN_FILTER_MAX = 40;

const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * `GET /api/admin/clients` (M2-T3, user decisions 2026-11-18): offset pagination + `q` search
 * (workspace name/slug, owner email/name; case-insensitive, partial), `status`, created-at range
 * (`createdFrom`/`createdTo`, inclusive) and `sort` (default newest first). M2-T12b adds `plan`
 * (a plan slug, or `none` = no plan); the format is checked here, an unknown slug is a 400 from
 * `AdminClientsService.list`.
 */
export class ListClientsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CLIENTS_PAGE_MAX)
  take: number = 50;

  /** Trimmed; blank = no search. */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(CLIENTS_SEARCH_MAX)
  q?: string;

  @IsOptional()
  @IsIn(WORKSPACE_STATUSES)
  status?: WorkspaceStatus;

  /** Inclusive lower bound; a date-only value starts at 00:00 UTC that day. */
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE_OR_DATE_TIME, {
    message: 'createdFrom must be an ISO 8601 date or a date-time with offset',
  })
  @IsISO8601({ strict: true })
  createdFrom?: string;

  /** Inclusive upper bound; a date-only value covers that whole UTC day. */
  @IsOptional()
  @IsString()
  @Matches(ISO_DATE_OR_DATE_TIME, {
    message: 'createdTo must be an ISO 8601 date or a date-time with offset',
  })
  @IsISO8601({ strict: true })
  createdTo?: string;

  /** Plan slug (`growth`) or `none` (workspaces without a plan). Case-sensitive, not trimmed. */
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_FILTER_MAX)
  @Matches(PLAN_FILTER, { message: 'plan must be a plan slug or none' })
  plan?: string;

  @IsOptional()
  @IsIn(CLIENT_SORTS)
  sort: ClientSort = 'newest';
}
