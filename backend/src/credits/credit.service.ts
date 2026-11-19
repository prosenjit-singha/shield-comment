import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { Database } from '../db/database.js';
import { monthlyCreditUsage } from '../db/schema/index.js';
import {
  findPlanFeatureConfig,
  findWorkspacePlanId,
} from '../meta/social-pages.queries.js';
import { assertCreditCost, dhakaMonthKey } from './credit-period.js';

/** `CreditService.usage()`: credits used this Dhaka month, the plan's monthly allowance, the month. */
export interface CreditUsage {
  used: number;
  limit: number;
  /** Asia/Dhaka calendar month, `YYYY-MM`. */
  period: string;
}

/**
 * Monthly AI credits (Module 5, M5-T11; user decisions 2026-11-19 D15 + D7 + D8). Exported by
 * `CreditsModule` for the moderation worker (M5-T12: `reserve` before every AI call, `release`
 * when a reserved call never reached the LLM) and the admin views (M5-T13: `usage`).
 *
 * The allowance is the workspace plan's `limits.monthlyAiCredits` (no plan = the Free plan; an
 * unknown workspace, a missing plan row or a missing key = 0). Every query is scoped by
 * `workspace_id`. Logs carry ids and counts only.
 */
@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** The workspace's monthly allowance from its plan (read on every call: plan edits apply at once). */
  async monthlyLimit(workspaceId: string): Promise<number> {
    const workspace = await findWorkspacePlanId(this.db, workspaceId);
    if (!workspace) return 0;
    const raw = await findPlanFeatureConfig(this.db, workspace.planId);
    if (raw === undefined || raw === null) return 0;
    return normalizeFeatureConfig(raw).limits.monthlyAiCredits;
  }

  /**
   * Reserves `cost` credits in the Dhaka month of `at`. `true` = reserved; `false` = it would pass
   * the limit (nothing changed). The guard is **one** statement: `insert … on conflict (workspace,
   * month) do update set used = used + cost where used + cost <= limit returning`, so parallel
   * reserves serialise on the row and the balance never passes the limit (D7).
   */
  async reserve(
    workspaceId: string,
    cost: number,
    at: Date = new Date(),
  ): Promise<boolean> {
    assertCreditCost(cost);
    const month = dhakaMonthKey(at);
    const limit = await this.monthlyLimit(workspaceId);
    if (cost > limit) {
      this.logger.debug(
        `credits refused workspace=${workspaceId} month=${month} cost=${cost} limit=${limit}`,
      );
      return false;
    }
    const t = monthlyCreditUsage;
    const rows = await this.db
      .insert(t)
      .values({ workspaceId, month, used: cost })
      .onConflictDoUpdate({
        target: [t.workspaceId, t.month],
        set: { used: sql`${t.used} + ${cost}`, updatedAt: sql`now()` },
        setWhere: sql`${t.used} + ${cost} <= ${limit}`,
      })
      .returning({ used: t.used });
    const reserved = rows.length > 0;
    if (!reserved) {
      this.logger.debug(
        `credits refused workspace=${workspaceId} month=${month} cost=${cost} limit=${limit}`,
      );
    }
    return reserved;
  }

  /**
   * Gives back `cost` credits of a reserve whose AI call never reached the LLM. `at` must fall in
   * the same Dhaka month as the reserve (pass the reserve's `at`). Never below 0; `false` when the
   * month has no row (nothing to give back).
   */
  async release(
    workspaceId: string,
    cost: number,
    at: Date = new Date(),
  ): Promise<boolean> {
    assertCreditCost(cost);
    const month = dhakaMonthKey(at);
    const t = monthlyCreditUsage;
    const rows = await this.db
      .update(t)
      .set({ used: sql`greatest(${t.used} - ${cost}, 0)` })
      .where(and(eq(t.workspaceId, workspaceId), eq(t.month, month)))
      .returning({ id: t.id });
    return rows.length > 0;
  }

  /** Credits used in the Dhaka month of `at` (0 without a row), the plan allowance and the month. */
  async usage(
    workspaceId: string,
    at: Date = new Date(),
  ): Promise<CreditUsage> {
    const period = dhakaMonthKey(at);
    const t = monthlyCreditUsage;
    const [[row], limit] = await Promise.all([
      this.db
        .select({ used: t.used })
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.month, period))),
      this.monthlyLimit(workspaceId),
    ]);
    return { used: row?.used ?? 0, limit, period };
  }
}
