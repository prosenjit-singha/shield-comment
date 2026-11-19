import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  planAuditLogs,
  platformSettings,
  plans,
  users,
} from '../db/schema/index.js';
import type { PlatformSettings } from './dto/platform-settings.dto.js';
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
  toAdminPlan,
  yearlyPriceError,
} from './plan-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const planColumns = {
  id: plans.id,
  slug: plans.slug,
  name: plans.name,
  sortOrder: plans.sortOrder,
  isActive: plans.isActive,
  monthlyPriceBdt: plans.monthlyPriceBdt,
  yearlyMonthlyPriceBdt: plans.yearlyMonthlyPriceBdt,
  badgeEn: plans.badgeEn,
  badgeBn: plans.badgeBn,
  descriptionEn: plans.descriptionEn,
  descriptionBn: plans.descriptionBn,
  isHighlighted: plans.isHighlighted,
  offerPriceBdt: plans.offerPriceBdt,
  offerBadge: plans.offerBadge,
  trialDays: plans.trialDays,
  trialCommentLimit: plans.trialCommentLimit,
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

  /**
   * Active plans, `sort_order` then name. Inactive plans (the deactivated `free` row, PW-D7) are
   * left out of the editor; their audit rows still show in `listAudit`.
   */
  async list(): Promise<AdminPlansResponse> {
    const rows = await this.db
      .select(planColumns)
      .from(plans)
      .where(eq(plans.isActive, true))
      .orderBy(asc(plans.sortOrder), asc(plans.name));
    return { items: rows.map(toAdminPlan) };
  }

  /**
   * Partial update of one plan. The row is locked (`FOR UPDATE`) so the yearly rule (yearly ≤
   * monthly), the `featureConfig` merge and the audit diff see the latest values even with
   * concurrent saves. A real change writes one `plan_audit_logs` row (only the changed fields) in
   * the same transaction; a body that changes nothing is a no-op: no update (`updatedAt` kept), no
   * audit row. `isHighlighted: true` (PR-D9) first locks every plan (id order, so two highlight
   * saves queue instead of deadlocking) and clears the flag on the others, each with its own
   * audit row.
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
      if (patch.isHighlighted === true) {
        await tx
          .select({ id: plans.id })
          .from(plans)
          .orderBy(asc(plans.id))
          .for('update');
      }
      const [current] = await tx
        .select(planColumns)
        .from(plans)
        .where(eq(plans.id, planId))
        .for('update');
      if (!current) throw new NotFoundException('Plan not found');
      const next = mergePlanPatch(current, patch);
      const error = yearlyPriceError(next);
      if (error) throw new BadRequestException(error);
      const changes = diffPlanValues(current, next);
      if (changes.length === 0) return toAdminPlan(current);
      const audit = (id: string, rowChanges: typeof changes) =>
        tx.insert(planAuditLogs).values({
          planId: id,
          adminId: actor.adminId,
          action: 'UPDATE',
          changes: rowChanges,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        });
      if (next.isHighlighted && !current.isHighlighted) {
        const cleared = await tx
          .update(plans)
          .set({ isHighlighted: false })
          .where(and(eq(plans.isHighlighted, true), ne(plans.id, current.id)))
          .returning({ id: plans.id });
        for (const other of cleared) {
          await audit(other.id, [
            { field: 'isHighlighted', before: true, after: false },
          ]);
        }
      }
      const [updated] = await tx
        .update(plans)
        .set(next)
        .where(eq(plans.id, current.id))
        .returning(planColumns);
      if (!updated) throw new NotFoundException('Plan not found');
      await audit(current.id, changes);
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

  /** Platform settings (PR-D18); all `null` until the first save. */
  async platformSettings(): Promise<PlatformSettings> {
    const [row] = await this.db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.id, 1));
    return {
      supportWhatsappNumber: row?.supportWhatsappNumber ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** Upserts row `id = 1` (DB check `platform_settings_support_whatsapp_number_check` is the backstop). */
  async updatePlatformSettings(
    supportWhatsappNumber: string | null,
    adminId: string,
  ): Promise<PlatformSettings> {
    const values = { supportWhatsappNumber, updatedById: adminId };
    const [row] = await this.db
      .insert(platformSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({
        target: platformSettings.id,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return {
      supportWhatsappNumber: row!.supportWhatsappNumber,
      updatedAt: row!.updatedAt.toISOString(),
    };
  }
}
