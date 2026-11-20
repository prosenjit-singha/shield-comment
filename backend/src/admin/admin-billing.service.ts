import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { count, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { paymentTransactions, plans, workspaces } from '../db/schema/index.js';
import { gatewayLabel } from '../payments/gateway-label.js';
import type {
  ListTransactionsQueryDto,
  TransactionList,
} from './dto/billing-transactions.dto.js';

/**
 * Billing transactions for the super admin (A4): every `payment_transactions` row across all
 * accounts (super admin only, `SuperAdminGuard`), newest first (M8-T2; shape = M2-T9).
 */
@Injectable()
export class AdminBillingService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async listTransactions(
    query: ListTransactionsQueryDto,
  ): Promise<TransactionList> {
    const { skip, take } = query;
    const t = paymentTransactions;
    const [rows, [totals]] = await Promise.all([
      this.db
        .select({
          id: t.id,
          workspaceId: workspaces.id,
          workspaceName: workspaces.name,
          planId: plans.id,
          planName: plans.name,
          amountBdt: t.amountBdt,
          gateway: t.gateway,
          cardType: t.cardType,
          status: t.status,
          tranId: t.tranId,
          createdAt: t.createdAt,
        })
        .from(t)
        .innerJoin(workspaces, eq(workspaces.id, t.workspaceId))
        .innerJoin(plans, eq(plans.id, t.planId))
        // uuidv7 ids break ties in insert order, so paging is stable.
        .orderBy(desc(t.createdAt), desc(t.id))
        .offset(skip)
        .limit(take),
      this.db.select({ total: count() }).from(t),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        workspace: { id: r.workspaceId, name: r.workspaceName },
        plan: { id: r.planId, name: r.planName },
        amountBdt: r.amountBdt,
        gateway: gatewayLabel(r.gateway, r.cardType),
        status: r.status,
        tranId: r.tranId,
        createdAt: r.createdAt.toISOString(),
      })),
      total: totals?.total ?? 0,
      skip,
      take,
    };
  }
}
