import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminBillingService } from './admin-billing.service.js';
import {
  ListTransactionsQueryDto,
  type TransactionList,
} from './dto/billing-transactions.dto.js';

@Controller('admin/billing')
@UseGuards(SuperAdminGuard)
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService) {}

  /** `?skip=0&take=50` (max 100). Empty `{ items: [], total: 0, skip, take }` until Module 8. */
  @Get('transactions')
  transactions(
    @Query() query: ListTransactionsQueryDto,
  ): Promise<TransactionList> {
    return this.billing.listTransactions(query);
  }
}
