import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Session } from '@thallesp/nestjs-better-auth';
import type {
  AuthRequest,
  AuthSession,
  WorkspaceContext,
} from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { IMPERSONATION_READ_ONLY } from '../auth/workspace-invites.js';
import type { PaymentPrice } from '../db/schema/index.js';
import { BillingSummaryService } from './billing-summary.service.js';
import {
  CheckoutService,
  type CheckoutResult,
  type PaymentStatusView,
} from './checkout.service.js';
import type { BillingSummary } from './dto/billing-summary.dto.js';
import { CheckoutDto, CouponPreviewDto } from './dto/checkout.dto.js';
import { StartTrialDto } from './dto/start-trial.dto.js';
import { SubscriptionService } from './subscription.service.js';

/** D2: an impersonated session reads billing but never pays (403 `IMPERSONATION_READ_ONLY`). */
function assertNotImpersonated(session: AuthSession): void {
  if (session.session.impersonatedBy)
    throw new ForbiddenException({
      message: 'Payments are not allowed while impersonating.',
      code: IMPERSONATION_READ_ONLY,
    });
}

/**
 * Per-account rate limit of the payment routes (owner only, one account per owner user, so the
 * user id tracks the account). In-memory per API process; the `ThrottlerModule` options + storage
 * are global (registered by `MetaCallbacksModule`). Over it → 429.
 */
const perAccount = (limit: number) =>
  Throttle({
    default: {
      limit,
      ttl: 600_000,
      getTracker: (req) =>
        `billing:${(req as AuthRequest).session?.user.id ?? 'none'}`,
    },
  });

/**
 * Client billing routes under `workspaces/:workspaceId/billing` (non-member or unknown workspace
 * 404, no session 401):
 * - `GET summary` (PW-T6, plan §3.7): **any member**, an impersonated session too (the guard keeps
 *   it on its own workspace). Not cached (`no-store`): usage moves with every comment.
 * - `POST trial` (PR-T3, PR-D10): **owner only** (others 403); an impersonated session is refused
 *   (403: an admin never starts a client's trial). 201 + the new summary.
 * - `POST coupon` (M8-T4, reading 7) → 200 `{ price, amountBdt }` and `POST checkout` (M8-T4) →
 *   201 `{ tranId, gatewayUrl }` or `{ tranId, paid: true }` (৳0): **owner only** (D2),
 *   impersonated 403 `IMPERSONATION_READ_ONLY`, rate-limited per account (20 / 10 per 10 min).
 *   Codes: `CheckoutService`.
 * - `GET payments/:tranId` (M8-T5): one payment of the workspace's billing account for the
 *   return page, **owner + admin** (D2; impersonated read ok); another account's id → 404.
 */
@Controller('workspaces/:workspaceId/billing')
@UseGuards(WorkspaceAccessGuard)
export class BillingSummaryController {
  constructor(
    private readonly billing: BillingSummaryService,
    private readonly subscriptions: SubscriptionService,
    private readonly checkout: CheckoutService,
  ) {}

  @Get('summary')
  @Header('Cache-Control', 'private, no-store')
  summary(
    @CurrentWorkspace() workspace: WorkspaceContext,
  ): Promise<BillingSummary> {
    return this.billing.summary(workspace.id);
  }

  @Post('trial')
  @Roles('owner')
  @Header('Cache-Control', 'private, no-store')
  async startTrial(
    @Session() session: AuthSession,
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() body: StartTrialDto,
  ): Promise<BillingSummary> {
    if (session.session.impersonatedBy) {
      throw new ForbiddenException(
        'Starting a trial is not allowed while impersonating',
      );
    }
    await this.subscriptions.startTrial(workspace.id, body.planId);
    return this.billing.summary(workspace.id);
  }

  @Post('coupon')
  @HttpCode(200)
  @Roles('owner')
  @UseGuards(ThrottlerGuard)
  @perAccount(20)
  @Header('Cache-Control', 'private, no-store')
  previewCoupon(
    @Session() session: AuthSession,
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() body: CouponPreviewDto,
  ): Promise<{ price: PaymentPrice; amountBdt: number }> {
    assertNotImpersonated(session);
    return this.checkout.previewCoupon(workspace.id, {
      planId: body.planId,
      interval: body.interval,
      couponCode: body.code,
    });
  }

  @Post('checkout')
  @Roles('owner')
  @UseGuards(ThrottlerGuard)
  @perAccount(10)
  @Header('Cache-Control', 'private, no-store')
  startCheckout(
    @Session() session: AuthSession,
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() body: CheckoutDto,
  ): Promise<CheckoutResult> {
    assertNotImpersonated(session);
    const { user } = session;
    return this.checkout.checkout(
      workspace.id,
      { userId: user.id, name: user.name, email: user.email },
      body,
    );
  }

  @Get('payments/:tranId')
  @Roles('owner', 'admin')
  @Header('Cache-Control', 'private, no-store')
  paymentStatus(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('tranId') tranId: string,
  ): Promise<PaymentStatusView> {
    return this.checkout.paymentStatus(workspace.id, tranId);
  }
}
