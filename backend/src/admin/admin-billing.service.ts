import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  lt,
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm';
import { isUuid } from '../auth/workspace-invites.js';
import { NOT_FAILED_OUTCOMES } from '../billing/payment-callback.js';
import { promotionLines } from '../billing/invoices.js';
import type { Database } from '../db/database.js';
import {
  type PaymentGateway,
  paymentEvents,
  paymentRefunds,
  paymentTransactions,
  plans,
  users,
  workspaces,
} from '../db/schema/index.js';
import { gatewayLabel, gatewayLabelSql } from '../payments/gateway-label.js';
import { escapeLike } from './client-list-query.js';
import { addDays, dhakaMidnight } from './dashboard-range.js';
import type {
  AdminPaymentEvent,
  AdminTransaction,
  AdminTransactionDetail,
  ListPaymentEventsQueryDto,
  ListTransactionsQueryDto,
  PaymentEventList,
  TransactionList,
} from './dto/billing-transactions.dto.js';

/** Who marked a refund (D9 audit row). */
export interface RefundActor {
  adminId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

const t = paymentTransactions;

/** The A4 row columns (list + detail). */
const rowColumns = {
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
  riskLevel: t.riskLevel,
  invoiceNumber: t.invoiceNumber,
};
interface Row {
  id: string;
  workspaceId: string;
  workspaceName: string;
  planId: string;
  planName: string;
  amountBdt: number;
  gateway: PaymentGateway;
  cardType: string | null;
  status: AdminTransaction['status'];
  tranId: string;
  createdAt: Date;
  riskLevel: number | null;
  invoiceNumber: string | null;
}

function toAdminTransaction(r: Row): AdminTransaction {
  return {
    id: r.id,
    workspace: { id: r.workspaceId, name: r.workspaceName },
    plan: { id: r.planId, name: r.planName },
    amountBdt: r.amountBdt,
    gateway: gatewayLabel(r.gateway, r.cardType),
    status: r.status,
    tranId: r.tranId,
    createdAt: r.createdAt.toISOString(),
    riskFlagged: r.riskLevel === 1,
    invoiceNumber: r.invoiceNumber,
  };
}

const toEvent = (e: {
  id: string;
  tranId: string | null;
  source: AdminPaymentEvent['source'];
  outcome: string;
  receivedAt: Date;
}): AdminPaymentEvent => ({ ...e, receivedAt: e.receivedAt.toISOString() });

/**
 * Billing for the super admin (A4; `SuperAdminGuard`, cross-account by design): transactions with
 * filters + a detail sheet, the failed-callback list, D9 "mark refunded" (M8-T8; list M8-T2).
 */
@Injectable()
export class AdminBillingService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async listTransactions(
    query: ListTransactionsQueryDto,
  ): Promise<TransactionList> {
    const { skip, take } = query;
    const where = this.transactionsWhere(query);
    const [rows, [totals]] = await Promise.all([
      this.db
        .select(rowColumns)
        .from(t)
        .innerJoin(workspaces, eq(workspaces.id, t.workspaceId))
        .innerJoin(plans, eq(plans.id, t.planId))
        .leftJoin(users, eq(users.id, t.userId))
        .where(where)
        // uuidv7 ids break ties in insert order, so paging is stable.
        .orderBy(desc(t.createdAt), desc(t.id))
        .offset(skip)
        .limit(take),
      this.db
        .select({ total: count() })
        .from(t)
        .innerJoin(workspaces, eq(workspaces.id, t.workspaceId))
        .leftJoin(users, eq(users.id, t.userId))
        .where(where),
    ]);
    return {
      items: rows.map(toAdminTransaction),
      total: totals?.total ?? 0,
      skip,
      take,
    };
  }

  /** Filters (validated by the DTO); `from > to` → 400. */
  private transactionsWhere(q: ListTransactionsQueryDto): SQL | undefined {
    if (q.from && q.to && q.from > q.to)
      throw new BadRequestException('from must be on or before to');
    const conditions: (SQL | undefined)[] = [];
    if (q.status) conditions.push(eq(t.status, q.status));
    if (q.gateway)
      conditions.push(eq(gatewayLabelSql(t.gateway, t.cardType), q.gateway));
    if (q.q) {
      const pattern = `%${escapeLike(q.q)}%`;
      conditions.push(
        or(
          ilike(workspaces.name, pattern),
          ilike(users.name, pattern),
          ilike(users.email, pattern),
          ilike(t.tranId, pattern),
        ),
      );
    }
    if (q.from) conditions.push(gte(t.createdAt, dhakaMidnight(q.from)));
    if (q.to) conditions.push(lt(t.createdAt, dhakaMidnight(addDays(q.to, 1))));
    return and(...conditions);
  }

  /** A4 sheet: the row + payer, term, price lines, its callbacks and the D9 refund audit. 404 unknown / non-uuid. */
  async getTransaction(id: string): Promise<AdminTransactionDetail> {
    if (!isUuid(id)) throw transactionNotFound();
    const [row] = await this.db
      .select({
        ...rowColumns,
        kind: t.kind,
        interval: t.interval,
        userId: users.id,
        userName: users.name,
        userEmail: users.email,
        paidAt: t.paidAt,
        termStart: t.termStart,
        termEnd: t.termEnd,
        valId: t.valId,
        bankTranId: t.bankTranId,
        price: t.price,
      })
      .from(t)
      .innerJoin(workspaces, eq(workspaces.id, t.workspaceId))
      .innerJoin(plans, eq(plans.id, t.planId))
      .leftJoin(users, eq(users.id, t.userId))
      .where(eq(t.id, id));
    if (!row) throw transactionNotFound();
    const [events, [refund]] = await Promise.all([
      this.db
        .select({
          id: paymentEvents.id,
          tranId: paymentEvents.tranId,
          source: paymentEvents.source,
          outcome: paymentEvents.outcome,
          receivedAt: paymentEvents.receivedAt,
        })
        .from(paymentEvents)
        .where(eq(paymentEvents.tranId, row.tranId))
        .orderBy(asc(paymentEvents.receivedAt), asc(paymentEvents.id)),
      this.db
        .select({
          adminId: users.id,
          adminName: users.name,
          reason: paymentRefunds.reason,
          createdAt: paymentRefunds.createdAt,
        })
        .from(paymentRefunds)
        .innerJoin(users, eq(users.id, paymentRefunds.adminId))
        .where(eq(paymentRefunds.paymentTransactionId, id)),
    ]);
    return {
      ...toAdminTransaction(row),
      kind: row.kind,
      interval: row.interval,
      user:
        row.userId && row.userName !== null && row.userEmail !== null
          ? { id: row.userId, name: row.userName, email: row.userEmail }
          : null,
      paidAt: row.paidAt?.toISOString() ?? null,
      term:
        row.termStart && row.termEnd
          ? {
              start: row.termStart.toISOString(),
              end: row.termEnd.toISOString(),
            }
          : null,
      valId: row.valId,
      bankTranId: row.bankTranId,
      cardType: row.cardType,
      riskLevel: row.riskLevel,
      listPriceBdt: row.price.listChargedBdt,
      promotions: promotionLines(row.price),
      creditBdt: row.price.creditBdt,
      events: events.map(toEvent),
      refund: refund
        ? {
            admin: { id: refund.adminId, name: refund.adminName },
            reason: refund.reason,
            createdAt: refund.createdAt.toISOString(),
          }
        : null,
    };
  }

  /**
   * D9: PAID → REFUNDED (the money went back in the SSLCommerz merchant panel). Status only: the
   * settled facts (paid_at, invoice, subscription, term) stay, the plan is not touched. One
   * `payment_refunds` audit row in the same transaction, after the row's `FOR UPDATE` lock.
   * 404 unknown / non-uuid · 409 `NOT_REFUNDABLE` unless PAID (a ৳0 PROMOTION row is PAID too).
   */
  async refund(
    id: string,
    reason: string,
    actor: RefundActor,
  ): Promise<AdminTransactionDetail> {
    if (!isUuid(id)) throw transactionNotFound();
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ status: t.status })
        .from(t)
        .where(eq(t.id, id))
        .for('update');
      if (!row) throw transactionNotFound();
      if (row.status !== 'PAID')
        throw new ConflictException({
          message: `Only PAID transactions can be marked refunded (this one is ${row.status})`,
          code: 'NOT_REFUNDABLE',
        });
      await tx.update(t).set({ status: 'REFUNDED' }).where(eq(t.id, id));
      await tx.insert(paymentRefunds).values({
        paymentTransactionId: id,
        adminId: actor.adminId,
        reason,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
    });
    return this.getTransaction(id);
  }

  /** SSLCommerz callbacks, newest first; `failed` = outcomes outside `NOT_FAILED_OUTCOMES`. */
  async listEvents(
    query: ListPaymentEventsQueryDto,
  ): Promise<PaymentEventList> {
    const { skip, take } = query;
    const e = paymentEvents;
    const where =
      query.outcome === 'failed'
        ? notInArray(e.outcome, [...NOT_FAILED_OUTCOMES])
        : undefined;
    const [rows, [totals]] = await Promise.all([
      this.db
        .select({
          id: e.id,
          tranId: e.tranId,
          source: e.source,
          outcome: e.outcome,
          receivedAt: e.receivedAt,
          transactionId: t.id,
          workspaceId: workspaces.id,
          workspaceName: workspaces.name,
        })
        .from(e)
        .leftJoin(t, eq(t.tranId, e.tranId))
        .leftJoin(workspaces, eq(workspaces.id, t.workspaceId))
        .where(where)
        .orderBy(desc(e.receivedAt), desc(e.id))
        .offset(skip)
        .limit(take),
      this.db.select({ total: count() }).from(e).where(where),
    ]);
    return {
      items: rows.map(
        ({ transactionId, workspaceId, workspaceName, ...event }) => ({
          ...toEvent(event),
          transaction:
            transactionId && workspaceId && workspaceName !== null
              ? {
                  id: transactionId,
                  workspace: { id: workspaceId, name: workspaceName },
                }
              : null,
        }),
      ),
      total: totals?.total ?? 0,
      skip,
      take,
    };
  }
}

const transactionNotFound = () =>
  new NotFoundException('Transaction not found');
