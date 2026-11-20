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
  TICKET_SUBJECT_MAX,
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

/** Multipart fields are strings: `"true"`/`"false"` → boolean; anything else is left for `@IsBoolean`. */
const formBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Offset pagination + `status`, shared by the admin list and the client list
 * (`GET /api/workspaces/:workspaceId/support/tickets`, M7-T2).
 */
export class TicketsPageQueryDto {
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
}

/**
 * `GET /api/admin/tickets` (M2-T7): offset pagination (newest first) + filters `status`,
 * `category`, `priority`, `workspaceId` and `q` (case-insensitive partial match on the subject).
 */
export class ListTicketsQueryDto extends TicketsPageQueryDto {
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

/** `POST /api/workspaces/:workspaceId/support/tickets/:id/reply` (M7-T2): body only. */
export class ClientReplyTicketDto {
  /** Required; trimmed, 1–5000 characters. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TICKET_MESSAGE_BODY_MAX)
  body!: string;
}

/**
 * `POST /api/workspaces/:workspaceId/support/tickets` (M7-T2, D3): the client picks category,
 * subject and the first message; `priority`/`status` are support's (sending them → 400).
 */
export class CreateTicketDto extends ClientReplyTicketDto {
  @IsIn(TICKET_CATEGORIES)
  category!: TicketCategory;

  /** Required; trimmed, 1–200 characters. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TICKET_SUBJECT_MAX)
  subject!: string;
}

/** `POST /api/admin/tickets/:id/reply`. */
export class ReplyTicketDto extends ClientReplyTicketDto {
  /** Admin-only note, hidden from the client later. Default `false`. */
  @IsOptional()
  @Transform(formBoolean)
  @IsBoolean()
  isInternalNote: boolean = false;
}

/** `PATCH /api/admin/tickets/:id/status`: free moves, same status = no-op. */
export class UpdateTicketStatusDto {
  @IsIn(TICKET_STATUSES)
  status!: TicketStatus;
}
