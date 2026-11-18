import { Injectable } from '@nestjs/common';
import type {
  ListTransactionsQueryDto,
  TransactionList,
} from './dto/billing-transactions.dto.js';

/**
 * Billing transactions for the super admin (A4). No payments table exists until Module 8
 * (SSLCommerz), so the list is always empty but already has its final shape (user decision
 * 2026-11-18). Module 8 replaces the body with a query on `payments` (newest first).
 */
@Injectable()
export class AdminBillingService {
  listTransactions(query: ListTransactionsQueryDto): Promise<TransactionList> {
    return Promise.resolve({
      items: [],
      total: 0,
      skip: query.skip,
      take: query.take,
    });
  }
}
