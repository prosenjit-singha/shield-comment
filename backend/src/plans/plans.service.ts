import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { platformSettings, plans } from '../db/schema/index.js';
import { PromotionService } from '../promotions/promotion.service.js';
import type { PublicPlansResponse } from './dto/public-plan.dto.js';
import { toPublicPlan, toPublicPlans } from './public-plan.js';

/** Public plan list (PW-T6, PR-T2). Plans and promotions are global (not tenant data); read-only. */
@Injectable()
export class PlansService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly promotions: PromotionService,
  ) {}

  /**
   * Active plans only, sorted like the admin editor (`sort_order`, then name), each priced with
   * its best live discount and its live trial; plus the WhatsApp number (`platform_settings`).
   */
  async listPublic(now = new Date()): Promise<PublicPlansResponse> {
    const rows = await this.db
      .select({
        id: plans.id,
        slug: plans.slug,
        name: plans.name,
        monthlyPriceBdt: plans.monthlyPriceBdt,
        yearlyMonthlyPriceBdt: plans.yearlyMonthlyPriceBdt,
        badgeEn: plans.badgeEn,
        badgeBn: plans.badgeBn,
        descriptionEn: plans.descriptionEn,
        descriptionBn: plans.descriptionBn,
        isHighlighted: plans.isHighlighted,
        featureConfig: plans.featureConfig,
      })
      .from(plans)
      .where(eq(plans.isActive, true))
      .orderBy(asc(plans.sortOrder), asc(plans.name));
    const ids = rows.map((r) => r.id);
    const [discounts, trials, [settings]] = await Promise.all([
      this.promotions.liveDiscountsFor(ids, now),
      this.promotions.liveTrialsFor(ids, now),
      this.db
        .select({ number: platformSettings.supportWhatsappNumber })
        .from(platformSettings)
        .where(eq(platformSettings.id, 1)),
    ]);
    return toPublicPlans(
      rows.map((row) =>
        toPublicPlan(row, discounts.get(row.id)!, trials.get(row.id)!),
      ),
      settings?.number ?? null,
    );
  }
}
