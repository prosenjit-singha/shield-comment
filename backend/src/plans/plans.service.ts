import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { plans } from '../db/schema/index.js';
import type { PublicPlansResponse } from './dto/public-plan.dto.js';
import { toPublicPlan } from './public-plan.js';

/** Public plan list (PW-T6). Plans are global (not tenant data); read-only. */
@Injectable()
export class PlansService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * Active plans only (the deactivated `free` row never appears, PW-D7), sorted like the admin
   * editor: `sort_order`, then name.
   */
  async listPublic(): Promise<PublicPlansResponse> {
    const rows = await this.db
      .select({
        id: plans.id,
        slug: plans.slug,
        name: plans.name,
        originalPriceBdt: plans.originalPriceBdt,
        offerPriceBdt: plans.offerPriceBdt,
        offerBadge: plans.offerBadge,
        yearlyMonthlyPriceBdt: plans.yearlyMonthlyPriceBdt,
        trialDays: plans.trialDays,
        trialCommentLimit: plans.trialCommentLimit,
        featureConfig: plans.featureConfig,
      })
      .from(plans)
      .where(eq(plans.isActive, true))
      .orderBy(asc(plans.sortOrder), asc(plans.name));
    return { items: rows.map(toPublicPlan) };
  }
}
