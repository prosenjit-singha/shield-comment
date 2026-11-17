import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const CLIENTS_PAGE_MAX = 100;

/** Offset pagination for `GET /api/admin/clients` (no filters/search yet). */
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
}
