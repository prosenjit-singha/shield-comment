import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import type {
  PlanAuditAction,
  PlanAuditChange,
} from '../../db/schema/index.js';

export const PLAN_AUDIT_PAGE_MAX = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /api/admin/settings/plans/audit` query (M2-T15). Same paging rules as the other admin lists:
 * `skip` int ≥ 0 (default 0), `take` int 1–100 (default 50). `planId` (UUID) narrows to one plan;
 * a well-formed id of an unknown plan simply returns an empty page. Any other param → 400.
 */
export class ListPlanAuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PLAN_AUDIT_PAGE_MAX)
  take: number = 50;

  @IsOptional()
  @Matches(UUID, { message: 'planId must be a UUID' })
  planId?: string;
}

/**
 * One plan edit. `changes` lists only the fields that changed, in `PLAN_AUDIT_FIELDS` order
 * (`monthlyPriceBdt`, `yearlyMonthlyPriceBdt`, badges, descriptions, `isHighlighted`,
 * `featureConfig.limits.*`, `featureConfig.features.*`; old rows may carry
 * `LEGACY_PLAN_AUDIT_FIELDS`); prices are whole BDT, `null` = cleared.
 */
export interface PlanAuditEntry {
  id: string;
  plan: { id: string; slug: string; name: string };
  admin: { id: string; name: string; email: string };
  action: PlanAuditAction;
  changes: PlanAuditChange[];
  /** Admin's IP (first `X-Forwarded-For` entry), `null` if unknown. */
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** `GET /api/admin/settings/plans/audit` response, newest first (`createdAt` desc, `id` desc). */
export interface PlanAuditList {
  items: PlanAuditEntry[];
  total: number;
  skip: number;
  take: number;
}
