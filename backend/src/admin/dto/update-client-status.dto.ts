import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { WORKSPACE_STATUS_REASON_MAX } from '../../db/schema/index.js';
import {
  WORKSPACE_STATUSES,
  type WorkspaceStatus,
} from './list-clients-query.dto.js';

/** `PATCH /api/admin/clients/:id/status` body (M2-T3). `reason` goes to the audit log. */
export class UpdateClientStatusDto {
  @IsIn(WORKSPACE_STATUSES)
  status!: WorkspaceStatus;

  /** Required; trimmed, 1–500 characters. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(WORKSPACE_STATUS_REASON_MAX)
  reason!: string;
}
