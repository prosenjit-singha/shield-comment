import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { asc, count, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { planAuditLogs, plans, users } from '../db/schema/index.js';
import type {
  ListPlanAuditQueryDto,
  PlanAuditList,
} from './dto/plan-audit.dto.js';
import type {
  AdminPlan,
  AdminPlansResponse,
  AdminPlanUpdateResponse,
  UpdatePlanDto,
} from './dto/plans.dto.js';
import {
  diffPlanValues,
  isEmptyPlanPatch,
  mergePlanPatch,
  offerPriceError,
  toAdminPlan,
} from './plan-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const planColumns = {
  id: plans.id,
  slug: plans.slug,
  name: plans.name,
  sortOrder: plans.sortOrder,
  isActive: plans.isActive,
  originalPriceBdt: plans.originalPriceBdt,
  offerPriceBdt: plans.offerPriceBdt,
  offerBadge: plans.offerBadge,
  featureConfig: plans.featureConfig,
  createdAt: plans.createdAt,
  updatedAt: plans.updatedAt,
};

/** Who made a plan edit and from where (M2-T15 audit row). */
export interface PlanEditActor {
  adminId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** A7 plan settings (M2-T11) + plan audit log (M2-T15). Plans are global (not tenant data): super admin only. */
@Injectable()
export class AdminPlansService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Every plan (active or not), `sort_order` then name. */
  async list(): Promise<AdminPlansResponse> {
    const rows = await this.db
      .select(planColumns)
      .from(plans)
      .orderBy(asc(plans.sortOrder), asc(plans.name));
    return { items: rows.map(toAdminPlan) };
  }

  /**
   * Partial update of one plan. The row is locked (`FOR UPDATE`) so the offer ≤ original rule,
   * the `featureConfig` merge and the audit diff see the latest values even with concurrent saves.
   * A real change writes one `plan_audit_logs` row (only the changed fields) in the same
   * transaction; a body that changes nothing is a no-op: no update (`updatedAt` kept), no audit row.
   */
  async update(
    planId: string,
    patch: UpdatePlanDto,
    actor: PlanEditActor,
  ): Promise<AdminPlanUpdateResponse> {
    if (!UUID.test(planId)) throw new NotFoundException('Plan not found');
    if (isEmptyPlanPatch(patch)) {
      throw new BadRequestException('Nothing to update');
    }
    const plan = await this.db.transaction(async (tx): Promise<AdminPlan> => {
      const [current] = await tx
        .select(planColumns)
        .from(plans)
        .where(eq(plans.id, planId))
        .for('update');
      if (!current) throw new NotFoundException('Plan not found');
      const next = mergePlanPatch(current, patch);
      const error = offerPriceError(next);
      if (error) throw new BadRequestException(error);
      const changes = diffPlanValues(current, next);
      if (changes.length === 0) return toAdminPlan(current);
      const [updated] = await tx
        .update(plans)
        .set(next)
        .where(eq(plans.id, current.id))
        .returning(planColumns);
      if (!updated) throw new NotFoundException('Plan not found');
      await tx.insert(planAuditLogs).values({
        planId: current.id,
        adminId: actor.adminId,
        action: 'UPDATE',
        changes,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
      return toAdminPlan(updated);
    });
    return { plan };
  }

  /** Plan edits, newest first (`created_at desc, id desc`), optionally for one plan. */
  async listAudit(query: ListPlanAuditQueryDto): Promise<PlanAuditList> {
    const where = query.planId
      ? eq(planAuditLogs.planId, query.planId)
      : undefined;
    const [rows, [totals]] = await Promise.all([
      this.db
        .select({
          id: planAuditLogs.id,
          action: planAuditLogs.action,
          changes: planAuditLogs.changes,
          ip: planAuditLogs.ipAddress,
          userAgent: planAuditLogs.userAgent,
          createdAt: planAuditLogs.createdAt,
          plan: { id: plans.id, slug: plans.slug, name: plans.name },
          admin: { id: users.id, name: users.name, email: users.email },
        })
        .from(planAuditLogs)
        .innerJoin(plans, eq(plans.id, planAuditLogs.planId))
        .innerJoin(users, eq(users.id, planAuditLogs.adminId))
        .where(where)
        .orderBy(desc(planAuditLogs.createdAt), desc(planAuditLogs.id))
        .offset(query.skip)
        .limit(query.take),
      this.db.select({ total: count() }).from(planAuditLogs).where(where),
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      total: totals?.total ?? 0,
      skip: query.skip,
      take: query.take,
    };
  }
}
