import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  TICKET_CATEGORIES,
  TICKET_MESSAGE_BODY_MAX,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from '../../db/schema/index.js';

export const TICKETS_PAGE_MAX = 100;
export const TICKETS_SEARCH_MAX = 100;

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * `GET /api/admin/tickets` (M2-T7): offset pagination (newest first) + filters `status`,
 * `category`, `priority`, `workspaceId` and `q` (case-insensitive partial match on the subject).
 */
export class ListTicketsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TICKETS_PAGE_MAX)
  take: number = 50;

  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: TicketStatus;

  @IsOptional()
  @IsIn(TICKET_CATEGORIES)
  category?: TicketCategory;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  @IsOptional()
  @IsString()
  @Matches(UUID, { message: 'workspaceId must be a UUID' })
  workspaceId?: string;

  /** Trimmed; blank = no search. */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(TICKETS_SEARCH_MAX)
  q?: string;
}

/** `POST /api/admin/tickets/:id/reply`. */
export class ReplyTicketDto {
  /** Required; trimmed, 1–5000 characters. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TICKET_MESSAGE_BODY_MAX)
  body!: string;

  /** Admin-only note, hidden from the client later. Default `false`. */
  @IsOptional()
  @IsBoolean()
  isInternalNote: boolean = false;
}

/** `PATCH /api/admin/tickets/:id/status`: free moves, same status = no-op. */
export class UpdateTicketStatusDto {
  @IsIn(TICKET_STATUSES)
  status!: TicketStatus;
}
