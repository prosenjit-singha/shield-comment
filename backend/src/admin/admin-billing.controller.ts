import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth-session.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { requestIp } from './admin-impersonation.service.js';
import { AdminBillingService } from './admin-billing.service.js';
import {
  type AdminTransactionDetail,
  ListPaymentEventsQueryDto,
  ListTransactionsQueryDto,
  type PaymentEventList,
  RefundTransactionDto,
  type TransactionList,
} from './dto/billing-transactions.dto.js';
import { auditUserAgent } from './plan-rules.js';

@Controller('admin/billing')
@UseGuards(SuperAdminGuard)
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService) {}

  /**
   * `?skip&take` (max 100) + filters `status`, `gateway` (label), `q`, `from`/`to` (Dhaka dates)
   * → `{ items, total, skip, take }`, newest first (M8-T8).
   */
  @Get('transactions')
  transactions(
    @Query() query: ListTransactionsQueryDto,
  ): Promise<TransactionList> {
    return this.billing.listTransactions(query);
  }

  /** A4 transaction sheet (M8-T8). 404 unknown / non-uuid id. */
  @Get('transactions/:id')
  transaction(@Param('id') id: string): Promise<AdminTransactionDetail> {
    return this.billing.getTransaction(id);
  }

  /** D9: mark a PAID row REFUNDED `{ reason }` → the updated sheet. 409 `NOT_REFUNDABLE` otherwise. */
  @Post('transactions/:id/refund')
  @HttpCode(200)
  refund(
    @Param('id') id: string,
    @Body() body: RefundTransactionDto,
    @Session() session: AuthSession,
    @Req() req: Request,
  ): Promise<AdminTransactionDetail> {
    return this.billing.refund(id, body.reason, {
      adminId: session.user.id,
      ipAddress: requestIp(req),
      userAgent: auditUserAgent(req.headers['user-agent']),
    });
  }

  /** SSLCommerz callbacks `?skip&take&outcome=failed`, newest first (M8-T8, A4 "Failed IPNs"). */
  @Get('events')
  events(@Query() query: ListPaymentEventsQueryDto): Promise<PaymentEventList> {
    return this.billing.listEvents(query);
  }
}
