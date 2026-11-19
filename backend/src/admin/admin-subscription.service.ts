import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  billingAccounts,
  LIVE_SUBSCRIPTION_STATUSES,
  plans,
  subscriptionAuditLogs,
  subscriptions,
  workspaces,
} from '../db/schema/index.js';
import { planPrice } from '../plans/plan-price.js';
import type { AccountLiveSubscription } from '../wallet/live-subscription.queries.js';
import { WalletService } from '../wallet/wallet.service.js';
import { normalizeFeatureConfig } from './plan-rules.js';
import type {
  ActivateClientPlanDto,
  ActivateClientPlanResponse,
} from './dto/activate-client-plan.dto.js';
import {
  endedStatus,
  MANUAL_ACTIVATION_ERROR_CODES as CODES,
  manualTerm,
  startDateError,
  toActivationAudit,
} from './manual-activation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who activated the plan and from where (audit row). */
export interface ActivationActor {
  adminId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Super admin "Activate plan" (PW-T9; user decision 2026-11-19 PW-D16, plan §3.9). The plan
 * belongs to the workspace's **billing account**, so this changes the plan of every workspace
 * linked to it (pooled limits, PW-D11). Payments and renewals stay Module 8.
 */
@Injectable()
export class AdminSubscriptionService {
  private readonly logger = new Logger(AdminSubscriptionService.name);
  /** Overridable clock (tests). */
  now: () => Date = () => new Date();

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly wallet: WalletService,
  ) {}

  /**
   * One transaction: lock the billing account → end its live subscription (`CANCELED` +
   * `canceled_at`; `EXPIRED` if its term was already over) → insert the new `ACTIVE` term (start
   * date 00:00 Dhaka + 1 month / 1 year, month-end clamp; `planPrice` snapshots) → fresh wallet
   * period (`used` 0, `PLAN_GRANT` by the admin) → one `subscription_audit_logs` row.
   *
   * 404 unknown workspace · 409 `NO_BILLING_ACCOUNT` · 400 `START_DATE_OUT_OF_RANGE`,
   * `TERM_ALREADY_ENDED`, `PLAN_NOT_AVAILABLE` (unknown / inactive), `YEARLY_PRICE_MISSING`.
   */
  async activate(
    workspaceId: string,
    input: ActivateClientPlanDto,
    actor: ActivationActor,
  ): Promise<ActivateClientPlanResponse> {
    if (!UUID.test(workspaceId))
      throw new NotFoundException('Workspace not found');
    const now = this.now();
    const dateError = startDateError(input.startDate, now);
    if (dateError) {
      throw new BadRequestException({
        message: dateError,
        code: CODES.startDateOutOfRange,
      });
    }
    const term = manualTerm(input.startDate, input.interval);
    if (term.end.getTime() <= now.getTime()) {
      throw new BadRequestException({
        message: 'This term would already be over: pick a later start date',
        code: CODES.termAlreadyEnded,
      });
    }

    const result = await this.db.transaction(async (tx) => {
      const [ws] = await tx
        .select({ billingAccountId: workspaces.billingAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!ws) throw new NotFoundException('Workspace not found');
      if (!ws.billingAccountId) {
        throw new ConflictException({
          message: 'This client has no billing account',
          code: CODES.noBillingAccount,
        });
      }
      const accountId = ws.billingAccountId;
      await tx
        .select({ id: billingAccounts.id })
        .from(billingAccounts)
        .where(eq(billingAccounts.id, accountId))
        .for('update');

      const [plan] = await tx
        .select({
          id: plans.id,
          slug: plans.slug,
          name: plans.name,
          isActive: plans.isActive,
          monthlyPriceBdt: plans.monthlyPriceBdt,
          offerPriceBdt: plans.offerPriceBdt,
          offerBadge: plans.offerBadge,
          yearlyMonthlyPriceBdt: plans.yearlyMonthlyPriceBdt,
          featureConfig: plans.featureConfig,
          trialCommentLimit: plans.trialCommentLimit,
        })
        .from(plans)
        .where(eq(plans.id, input.planId));
      if (!plan?.isActive) {
        throw new BadRequestException({
          message: 'This plan is not available',
          code: CODES.planNotAvailable,
        });
      }
      const price = planPrice(plan, input.interval);
      if (!price) {
        throw new BadRequestException({
          message: 'This plan has no yearly price',
          code: CODES.yearlyPriceMissing,
        });
      }

      // The live row by status (also a stale one past its term: the partial unique index
      // `subscriptions_one_live_per_account` counts it until the expiry job runs).
      const [old] = await tx
        .select({
          id: subscriptions.id,
          planId: subscriptions.planId,
          interval: subscriptions.interval,
          status: subscriptions.status,
          currentTermEnd: subscriptions.currentTermEnd,
        })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.billingAccountId, accountId),
            inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
          ),
        )
        .for('update');
      if (old) {
        await tx
          .update(subscriptions)
          .set(endedStatus(old, now))
          .where(
            and(
              eq(subscriptions.id, old.id),
              eq(subscriptions.billingAccountId, accountId),
            ),
          );
      }

      const [created] = await tx
        .insert(subscriptions)
        .values({
          billingAccountId: accountId,
          planId: plan.id,
          interval: input.interval,
          status: 'ACTIVE',
          startedAt: term.start,
          currentTermStart: term.start,
          currentTermEnd: term.end,
          pricePerMonthBdt: price.perMonthBdt,
          chargedBdt: price.chargedBdt,
        })
        .returning({ id: subscriptions.id });
      const live: AccountLiveSubscription = {
        billingAccountId: accountId,
        subscriptionId: created!.id,
        status: 'ACTIVE',
        interval: input.interval,
        startedAt: term.start,
        trialEndsAt: null,
        currentTermStart: term.start,
        currentTermEnd: term.end,
        plan: {
          id: plan.id,
          slug: plan.slug,
          featureConfig: normalizeFeatureConfig(plan.featureConfig),
          trialCommentLimit: plan.trialCommentLimit,
        },
      };
      const balances = await this.wallet.startFreshPeriod(
        live,
        now,
        tx,
        actor.adminId,
      );

      await tx.insert(subscriptionAuditLogs).values(
        toActivationAudit({
          adminId: actor.adminId,
          billingAccountId: accountId,
          workspaceId,
          before: old ?? null,
          after: {
            id: created!.id,
            planId: plan.id,
            interval: input.interval,
            status: 'ACTIVE',
          },
          reason: input.reason,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        }),
      );
      const comments = balances.get('monthlyComments')!;
      this.logger.log(
        `manual plan activation account=${accountId} workspace=${workspaceId} subscription=${created!.id} plan=${plan.slug} interval=${input.interval} admin=${actor.adminId} replaced=${old?.id ?? 'none'}`,
      );
      return {
        subscription: {
          status: 'ACTIVE' as const,
          interval: input.interval,
          trialEndsAt: null,
          termEndsAt: term.end,
          plan: { id: plan.id, slug: plan.slug, name: plan.name },
        },
        comments: {
          used: comments.used,
          limit: comments.included + comments.added,
          resetsAt: comments.resetsAt,
        },
      };
    });
    return result;
  }
}
