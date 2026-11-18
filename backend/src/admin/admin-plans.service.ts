import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { plans } from '../db/schema/index.js';
import type {
  AdminPlan,
  AdminPlansResponse,
  AdminPlanUpdateResponse,
  UpdatePlanDto,
} from './dto/plans.dto.js';
import {
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

/** A7 plan settings (M2-T11). Plans are global (not tenant data): super admin only. */
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
   * Partial update of one plan. The row is locked (`FOR UPDATE`) so the offer ≤ original rule
   * and the `featureConfig` merge see the latest values even with concurrent saves.
   */
  async update(
    planId: string,
    patch: UpdatePlanDto,
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
      const [updated] = await tx
        .update(plans)
        .set(next)
        .where(eq(plans.id, current.id))
        .returning(planColumns);
      if (!updated) throw new NotFoundException('Plan not found');
      return toAdminPlan(updated);
    });
    return { plan };
  }
}
