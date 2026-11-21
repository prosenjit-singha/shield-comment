import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { isUuid } from '../auth/workspace-invites.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import {
  paymentTransactions as t,
  plans,
  SETTLED_PAYMENT_STATUSES,
  workspaces,
} from '../db/schema/index.js';
import {
  type InvoiceList,
  type InvoiceRow,
  type InvoiceView,
  toInvoiceListItem,
  toInvoiceView,
} from './invoices.js';

/**
 * Client invoices (M8-T7; D2, D8): the settled (PAID / REFUNDED) payments of the workspace's
 * billing account, so every workspace of the account sees the same invoices. Scoped by the
 * workspace → `billing_account_id` join; another account's row is a 404.
 */
@Injectable()
export class InvoicesService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** The account's settled rows, reached through `workspaceId` (+ `extra`). */
  private scope(workspaceId: string, extra?: SQL) {
    return and(
      eq(workspaces.id, workspaceId),
      inArray(t.status, [...SETTLED_PAYMENT_STATUSES]),
      extra,
    );
  }

  private rows(workspaceId: string, extra?: SQL) {
    return this.db
      .select({
        id: t.id,
        invoiceNumber: t.invoiceNumber,
        tranId: t.tranId,
        paidAt: t.paidAt,
        status: t.status,
        kind: t.kind,
        planId: t.planId,
        planName: plans.name,
        interval: t.interval,
        amountBdt: t.amountBdt,
        gateway: t.gateway,
        cardType: t.cardType,
        termStart: t.termStart,
        termEnd: t.termEnd,
        price: t.price,
      })
      .from(t)
      .innerJoin(
        workspaces,
        eq(workspaces.billingAccountId, t.billingAccountId),
      )
      .innerJoin(plans, eq(plans.id, t.planId))
      .where(this.scope(workspaceId, extra))
      .$dynamic();
  }

  async list(
    workspaceId: string,
    skip: number,
    take: number,
  ): Promise<InvoiceList> {
    const [rows, [totals]] = await Promise.all([
      this.rows(workspaceId)
        // uuidv7 ids break ties in insert order, so paging is stable.
        .orderBy(desc(t.paidAt), desc(t.id))
        .offset(skip)
        .limit(take),
      this.db
        .select({ total: count() })
        .from(t)
        .innerJoin(
          workspaces,
          eq(workspaces.billingAccountId, t.billingAccountId),
        )
        .where(this.scope(workspaceId)),
    ]);
    return {
      items: rows.map((r) => toInvoiceListItem(settled(r))),
      total: totals?.total ?? 0,
      skip,
      take,
    };
  }

  async get(workspaceId: string, invoiceId: string): Promise<InvoiceView> {
    const [row] = isUuid(invoiceId)
      ? await this.rows(workspaceId, eq(t.id, invoiceId))
      : [];
    if (!row) throw new NotFoundException('Invoice not found');
    return toInvoiceView(settled(row), {
      name: this.config.get('INVOICE_SELLER_NAME', { infer: true }) ?? null,
      address:
        this.config.get('INVOICE_SELLER_ADDRESS', { infer: true }) ?? null,
    });
  }
}

type SelectedRow = Omit<
  InvoiceRow,
  'invoiceNumber' | 'paidAt' | 'status' | 'termStart' | 'termEnd'
> & {
  invoiceNumber: string | null;
  paidAt: Date | null;
  status: string;
  termStart: Date | null;
  termEnd: Date | null;
};

/** The settled check guarantees these are set for PAID / REFUNDED rows. */
function settled(r: SelectedRow): InvoiceRow {
  const { invoiceNumber, paidAt, termStart, termEnd } = r;
  if (!invoiceNumber || !paidAt || !termStart || !termEnd)
    throw new Error(`settled payment ${r.id} is missing invoice fields`);
  return {
    ...r,
    invoiceNumber,
    paidAt,
    termStart,
    termEnd,
    status: r.status as InvoiceRow['status'],
  };
}
