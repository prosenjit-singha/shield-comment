import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  billingAccounts,
  plans,
  promotionPlans,
  promotionRedemptions,
  promotions,
  subscriptions,
  users,
  workspaces,
} from '../db/schema/index.js';
import type {
  AdminPromotion,
  AdminPromotionRedemptionsResponse,
  AdminPromotionResponse,
  AdminPromotionsResponse,
  CreatePromotionDto,
  ListPromotionsQueryDto,
  UpdatePromotionDto,
} from './dto/promotions.dto.js';
import { dhakaDate } from './manual-activation.js';
import {
  ADMIN_PROMOTION_ERROR_CODES as CODES,
  endOfDhakaDay,
  lockedChanges,
  promotionStatus,
  promotionTermsError,
  type PromotionTerms,
} from './promotion-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';

type Executor = Pick<Database, 'select'>;
type PromotionRow = typeof promotions.$inferSelect;

const redemptionCount = sql<number>`(select count(*)::int from promotion_redemptions r where r.promotion_id = promotions.id)`;

const pgError = (error: unknown) =>
  ((error as { cause?: unknown }).cause ?? error) as {
    code?: string;
    constraint?: string;
  };

const bad = (code: string, message: string) =>
  new BadRequestException({ message, code });

/**
 * Admin promotions (PR-T4; user decisions 2026-11-20 PR-D1, D2, D15, reading 8; plan doc §5.2,
 * §5.7). Promotions are global (not tenant data), super admin only. Edits are not audit-logged
 * (no table): the row keeps `created_by`, `stopped_by` and `updated_at`; logs carry ids only.
 */
@Injectable()
export class AdminPromotionsService {
  private readonly logger = new Logger(AdminPromotionsService.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * Every promotion (newest first) with targets, redemption count and status; `kind` filters in
   * SQL, `status` after the status is worked out.
   * ponytail: no paging, loads the whole table (admin-made, tens of rows); page it if it grows.
   */
  async list(
    query: ListPromotionsQueryDto,
    now = new Date(),
  ): Promise<AdminPromotionsResponse> {
    const rows = await this.db
      .select({ promotion: promotions, count: redemptionCount })
      .from(promotions)
      .where(query.kind ? eq(promotions.kind, query.kind) : undefined)
      .orderBy(desc(promotions.createdAt), desc(promotions.id));
    const items = await this.toAdmin(this.db, rows, now);
    return {
      items: query.status
        ? items.filter((p) => p.status === query.status)
        : items,
    };
  }

  async create(
    dto: CreatePromotionDto,
    adminId: string,
    now = new Date(),
  ): Promise<AdminPromotionResponse> {
    const terms: PromotionTerms = {
      kind: dto.kind,
      code: dto.code ?? null,
      allPlans: dto.allPlans ?? false,
      planIds: dto.planIds ?? [],
      trialDays: dto.trialDays ?? null,
      trialCommentLimit: dto.trialCommentLimit ?? null,
      discountType: dto.discountType ?? null,
      discountValue: dto.discountValue ?? null,
      discountScope: dto.discountScope ?? null,
      durationMonths: dto.durationMonths ?? null,
    };
    this.checkTerms(terms);
    const endsAt = this.endsAt(dto.endsOn, now);
    const id = await this.withCodeCheck(() =>
      this.db.transaction(async (tx) => {
        await this.checkPlans(tx, terms.planIds);
        const { planIds, ...columns } = terms;
        const [row] = await tx
          .insert(promotions)
          .values({
            ...columns,
            name: dto.name,
            endsAt: endsAt ?? null,
            maxRedemptions: dto.maxRedemptions ?? null,
            createdBy: adminId,
          })
          .returning({ id: promotions.id });
        if (planIds.length)
          await tx
            .insert(promotionPlans)
            .values(
              planIds.map((planId) => ({ promotionId: row!.id, planId })),
            );
        return row!.id;
      }),
    );
    this.logger.log(`promotion created promotion=${id} admin=${adminId}`);
    return { promotion: await this.load(this.db, id, now) };
  }

  /**
   * Partial update under the promotion's `FOR UPDATE` lock (the lock `redeem()` takes), so the
   * redemption count behind the reading-8 lock can't change mid-edit.
   */
  async update(
    id: string,
    dto: UpdatePromotionDto,
    now = new Date(),
  ): Promise<AdminPromotionResponse> {
    if (Object.values(dto).every((v) => v === undefined))
      throw new BadRequestException('Nothing to update');
    const endsAt = this.endsAt(dto.endsOn, now);
    await this.withCodeCheck(() =>
      this.db.transaction(async (tx) => {
        const current = await this.lockRow(tx, id);
        const [state] = await tx
          .select({ count: redemptionCount })
          .from(promotions)
          .where(eq(promotions.id, id));
        if (state!.count > 0) {
          const fields = lockedChanges(current, dto);
          if (fields.length)
            throw new ConflictException({
              message: `Money terms are locked after the first redemption: ${fields.join(', ')}`,
              code: CODES.termsLocked,
              details: { fields },
            });
        }
        const sent = <T>(value: T | undefined, stored: T): T =>
          value === undefined ? stored : value;
        const allPlans = sent(dto.allPlans, current.allPlans);
        // Turning `allPlans` on drops the stored targets unless new ones are sent.
        const planIds =
          dto.planIds ??
          (dto.allPlans === true
            ? []
            : (
                await tx
                  .select({ planId: promotionPlans.planId })
                  .from(promotionPlans)
                  .where(eq(promotionPlans.promotionId, id))
              ).map((r) => r.planId));
        const terms: PromotionTerms = {
          kind: current.kind,
          code: sent(dto.code, current.code),
          allPlans,
          planIds,
          trialDays: sent(dto.trialDays, current.trialDays),
          trialCommentLimit: sent(
            dto.trialCommentLimit,
            current.trialCommentLimit,
          ),
          discountType: sent(dto.discountType, current.discountType),
          discountValue: sent(dto.discountValue, current.discountValue),
          discountScope: sent(dto.discountScope, current.discountScope),
          durationMonths: sent(dto.durationMonths, current.durationMonths),
        };
        this.checkTerms(terms);
        if (dto.planIds) await this.checkPlans(tx, dto.planIds);
        const { planIds: _targets, ...columns } = terms;
        await tx
          .update(promotions)
          .set({
            ...columns,
            ...(dto.name !== undefined && { name: dto.name }),
            ...(endsAt !== undefined && { endsAt }),
            ...(dto.maxRedemptions !== undefined && {
              maxRedemptions: dto.maxRedemptions,
            }),
          })
          .where(eq(promotions.id, id));
        if (dto.planIds !== undefined || dto.allPlans !== undefined) {
          await tx
            .delete(promotionPlans)
            .where(eq(promotionPlans.promotionId, id));
          if (planIds.length)
            await tx
              .insert(promotionPlans)
              .values(planIds.map((planId) => ({ promotionId: id, planId })));
        }
      }),
    );
    this.logger.log(`promotion updated promotion=${id}`);
    return { promotion: await this.load(this.db, id, now) };
  }

  /** Stop (PR-D2): blocks new claims only (PR-D15). Idempotent: the first Stop is kept. */
  async stop(
    id: string,
    adminId: string,
    now = new Date(),
  ): Promise<AdminPromotionResponse> {
    if (!UUID.test(id)) throw new NotFoundException('Promotion not found');
    const [stopped] = await this.db
      .update(promotions)
      .set({ stoppedAt: now, stoppedBy: adminId })
      .where(and(eq(promotions.id, id), isNull(promotions.stoppedAt)))
      .returning({ id: promotions.id });
    if (stopped)
      this.logger.log(`promotion stopped promotion=${id} admin=${adminId}`);
    return { promotion: await this.load(this.db, id, now) };
  }

  /** Claims of one promotion, newest first. ponytail: no paging; add it when caps get large. */
  async redemptions(id: string): Promise<AdminPromotionRedemptionsResponse> {
    await this.load(this.db, id, new Date());
    const rows = await this.db
      .select({
        id: promotionRedemptions.id,
        redeemedAt: promotionRedemptions.redeemedAt,
        billingAccountId: promotionRedemptions.billingAccountId,
        client: { id: users.id, name: users.name, email: users.email },
        plan: { id: plans.id, slug: plans.slug, name: plans.name },
        discountBdtFirstTerm: promotionRedemptions.discountBdtFirstTerm,
        monthsUsed: promotionRedemptions.monthsUsed,
      })
      .from(promotionRedemptions)
      .innerJoin(
        billingAccounts,
        eq(billingAccounts.id, promotionRedemptions.billingAccountId),
      )
      .innerJoin(users, eq(users.id, billingAccounts.ownerUserId))
      .leftJoin(
        subscriptions,
        eq(subscriptions.id, promotionRedemptions.subscriptionId),
      )
      .leftJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(promotionRedemptions.promotionId, id))
      .orderBy(
        desc(promotionRedemptions.redeemedAt),
        desc(promotionRedemptions.id),
      );
    const accountIds = [...new Set(rows.map((r) => r.billingAccountId))];
    const firstWorkspace = new Map<string, { id: string; name: string }>();
    if (accountIds.length) {
      const linked = await this.db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          accountId: workspaces.billingAccountId,
        })
        .from(workspaces)
        .where(inArray(workspaces.billingAccountId, accountIds))
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
      for (const w of linked)
        if (!firstWorkspace.has(w.accountId!))
          firstWorkspace.set(w.accountId!, { id: w.id, name: w.name });
    }
    return {
      items: rows.map((r) => ({
        ...r,
        redeemedAt: r.redeemedAt.toISOString(),
        workspace: firstWorkspace.get(r.billingAccountId) ?? null,
      })),
    };
  }

  private checkTerms(terms: PromotionTerms): void {
    const error = promotionTermsError(terms);
    if (error) throw bad(CODES.invalidTerms, error);
  }

  /** `undefined` = not sent, `null` = until stopped; a date before today (Dhaka) → 400. */
  private endsAt(endsOn: string | null | undefined, now: Date) {
    if (endsOn === undefined || endsOn === null) return endsOn;
    if (endsOn < dhakaDate(now))
      throw bad(CODES.endsInPast, 'endsOn must be today or later');
    return endOfDhakaDay(endsOn);
  }

  /** Every target must be an active plan. */
  private async checkPlans(tx: Executor, planIds: readonly string[]) {
    if (!planIds.length) return;
    const found = await tx
      .select({ id: plans.id })
      .from(plans)
      .where(and(inArray(plans.id, [...planIds]), eq(plans.isActive, true)));
    if (found.length !== planIds.length)
      throw bad(CODES.planNotAvailable, 'Every target plan must be active');
  }

  /** Coupon code clash (unique index, case-insensitive since codes are stored uppercase) → 409. */
  private async withCodeCheck<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const pg = pgError(error);
      if (
        pg.code === UNIQUE_VIOLATION &&
        pg.constraint === 'promotions_code_unique'
      )
        throw new ConflictException({
          message: 'Another promotion already uses this code',
          code: CODES.codeTaken,
        });
      throw error;
    }
  }

  private async lockRow(tx: Executor, id: string): Promise<PromotionRow> {
    if (!UUID.test(id)) throw new NotFoundException('Promotion not found');
    const [row] = await tx
      .select()
      .from(promotions)
      .where(eq(promotions.id, id))
      .for('update');
    if (!row) throw new NotFoundException('Promotion not found');
    return row;
  }

  private async load(
    db: Executor,
    id: string,
    now: Date,
  ): Promise<AdminPromotion> {
    if (!UUID.test(id)) throw new NotFoundException('Promotion not found');
    const rows = await db
      .select({ promotion: promotions, count: redemptionCount })
      .from(promotions)
      .where(eq(promotions.id, id));
    const [item] = await this.toAdmin(db, rows, now);
    if (!item) throw new NotFoundException('Promotion not found');
    return item;
  }

  private async toAdmin(
    db: Executor,
    rows: { promotion: PromotionRow; count: number }[],
    now: Date,
  ): Promise<AdminPromotion[]> {
    const ids = rows.map((r) => r.promotion.id);
    const targets = ids.length
      ? await db
          .select({
            promotionId: promotionPlans.promotionId,
            id: plans.id,
            slug: plans.slug,
            name: plans.name,
          })
          .from(promotionPlans)
          .innerJoin(plans, eq(plans.id, promotionPlans.planId))
          .where(inArray(promotionPlans.promotionId, ids))
          .orderBy(asc(plans.sortOrder), asc(plans.name))
      : [];
    return rows.map(({ promotion: p, count }) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      code: p.code,
      allPlans: p.allPlans,
      plans: targets
        .filter((t) => t.promotionId === p.id)
        .map(({ id, slug, name }) => ({ id, slug, name })),
      endsAt: p.endsAt?.toISOString() ?? null,
      endsOn: p.endsAt ? dhakaDate(p.endsAt) : null,
      maxRedemptions: p.maxRedemptions,
      redemptionCount: count,
      status: promotionStatus(p, count, now),
      termsLocked: count > 0,
      stoppedAt: p.stoppedAt?.toISOString() ?? null,
      trialDays: p.trialDays,
      trialCommentLimit: p.trialCommentLimit,
      discountType: p.discountType,
      discountValue: p.discountValue,
      discountScope: p.discountScope,
      durationMonths: p.durationMonths,
      createdByAdmin: p.createdBy !== null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
  }
}
