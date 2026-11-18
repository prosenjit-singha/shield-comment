import { IsBoolean } from 'class-validator';

/** `PATCH /api/workspaces/:workspaceId/pages/:id/toggle` body: exactly `{ isActive: boolean }`. */
export class TogglePageDto {
  @IsBoolean()
  isActive!: boolean;
}
