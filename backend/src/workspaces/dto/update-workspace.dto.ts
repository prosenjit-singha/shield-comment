import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { WORKSPACE_NAME_MAX } from '../../auth/first-workspace.js';

export class UpdateWorkspaceDto {
  /** Trimmed, 1–80 characters (same rule as `workspaceName` at sign-up). */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(WORKSPACE_NAME_MAX)
  name!: string;
}
