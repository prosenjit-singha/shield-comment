import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq, gt, inArray, lte, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  walletBalances,
  walletEntries,
  wallets,
  workspaces,
} from '../db/schema/index.js';
import {
  findLiveSubscription,
  findLiveSubscriptions,
  type LiveSubscription,
  subscriptionPeriod,
} from './live-subscription.queries.js';
import {
  meterGrant,
  WALLET_METER_KEYS,
  type WalletMeter,
} from './wallet-meters.js';
import {
  assertWalletAmount,
  assertWalletInstant,
  type WalletPeriod,
} from './wallet-period.js';

/** `consume()` outcome (PW-D9: no live plan → the caller pauses moderation, PW-T4). */
export type WalletConsumeResult = 'ok' | 'limit_reached' | 'no_active_plan';

/** One meter's balance in the current period of the account's wallet. */
export interface WalletBalance {
  meter: WalletMeter;
  /** Granted from the plan (or the trial limit) at period start. */
  included: number;
  /** Future top-ups / extra limit (PW-D3); always 0 now. */
  added: number;
  used: number;
  /** `max(included + added − used, 0)`. */
  available: number;
  periodStart: Date;
  /** The stored reset time (PW-D4); for a trial, the trial end. */
  resetsAt: Date;
}

/** The Drizzle methods the wallet writes need (db or a transaction). */
export type WalletExecutor = Pick<Database, 'select' | 'insert' | 'update'>;

/**
 * The client wallet (PW-T2; user decisions 2026-11-19 PW-D3/D4/D9/D12/D14). One wallet per
 * billing account, one balance row per meter × period, reset monthly on the billing date
 * (Asia/Dhaka, month-end clamp). Not called by moderation yet (PW-T4 replaces `CreditService`).
 *
 * Periods roll forward lazily: the first `consume` of a period (in one transaction) creates the
 * wallet if missing, moves its stored period, writes the period's balance rows with the plan
 * limit **at that moment** (PW-D14) plus one `PLAN_GRANT` ledger entry each. The use itself is
 * **one** guarded `UPDATE … used = used + n WHERE used + n <= included + added`, so concurrent
 * consumes never pass the limit; the unique keys (`wallets.billing_account_id`, balance
 * `(wallet, meter, period_start)`) + `on conflict` keep them from creating duplicate rows.
 *
 * Every query is scoped by the billing account id (and the workspace id where it enters). Logs
 * carry ids and counts only.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * Uses `n` (integer 1–1,000, else `RangeError`) of `meter` for the workspace's account at
   * `now`. `ok` = counted; `limit_reached` = it would pass the period's limit (nothing changed);
   * `no_active_plan` = no billing account / live subscription / the term is over (nothing written).
   */
  async consume(
    workspaceId: string,
    meter: WalletMeter,
    n = 1,
    now: Date = new Date(),
  ): Promise<WalletConsumeResult> {
    assertWalletAmount(n);
    assertWalletInstant(now);
    const live = await findLiveSubscription(this.db, workspaceId, now);
    if (!live) {
      this.logger.debug(
        `wallet no_active_plan workspace=${workspaceId} meter=${meter} n=${n}`,
      );
      return 'no_active_plan';
    }
    const period = subscriptionPeriod(live, now);
    const account = live.billingAccountId;
    // Hot path: the period's balance row usually exists already (one statement).
    if (await this.use(this.db, account, meter, period.start, n)) return 'ok';
    const used = await this.db.transaction(async (tx) => {
      await this.writePeriod(tx, live, period);
      return this.use(tx, account, meter, period.start, n);
    });
    if (used) return 'ok';
    this.logger.debug(
      `wallet limit_reached account=${account} workspace=${workspaceId} meter=${meter} n=${n}`,
    );
    return 'limit_reached';
  }

  /**
   * Opens the period containing `now` for the workspace's account **now** instead of at the first
   * consume: wallet + balance rows (grant taken at this moment) + `PLAN_GRANT` entries; a no-op
   * when already open. For PW-T3's trial start (the trial limit is granted at trial start) and
   * later term starts. Pass `tx` to join the caller's transaction (the live subscription must be
   * visible in it). `false` = no live plan (nothing written).
   */
  async openPeriod(
    workspaceId: string,
    now: Date = new Date(),
    tx?: WalletExecutor,
  ): Promise<boolean> {
    assertWalletInstant(now);
    const run = async (ex: WalletExecutor): Promise<boolean> => {
      const live = await findLiveSubscription(ex, workspaceId, now);
      if (!live) return false;
      await this.writePeriod(ex, live, subscriptionPeriod(live, now));
      return true;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  /**
   * Gives back `n` of `meter` to the balance whose period contains `at` (the consume's instant
   * or its period start), never below 0. Scoped to the workspace's account wallet; works after
   * the plan ended. `false` = no such balance (nothing to give back).
   */
  async refund(
    workspaceId: string,
    meter: WalletMeter,
    n: number,
    at: Date,
  ): Promise<boolean> {
    assertWalletAmount(n);
    assertWalletInstant(at);
    const b = walletBalances;
    const target = this.db
      .select({ id: b.id })
      .from(b)
      .where(
        and(
          inArray(
            b.walletId,
            this.db
              .select({ id: wallets.id })
              .from(wallets)
              .innerJoin(
                workspaces,
                eq(workspaces.billingAccountId, wallets.billingAccountId),
              )
              .where(eq(workspaces.id, workspaceId)),
          ),
          eq(b.meter, meter),
          lte(b.periodStart, at),
          gt(b.periodEnd, at),
        ),
      )
      .orderBy(desc(b.periodStart))
      .limit(1);
    const rows = await this.db
      .update(b)
      .set({ used: sql`greatest(${b.used} - ${n}, 0)` })
      .where(inArray(b.id, target))
      .returning({ walletId: b.walletId });
    if (rows.length > 0) {
      this.logger.debug(
        `wallet refund workspace=${workspaceId} wallet=${rows[0]!.walletId} meter=${meter} n=${n}`,
      );
    }
    return rows.length > 0;
  }

  /**
   * The workspace account's `meter` balance in the period containing `now`, or `null` without a
   * live plan. Read-only: before the period's first consume it shows what that consume will grant
   * (the plan limit now, `used` 0).
   */
  async balance(
    workspaceId: string,
    meter: WalletMeter = 'monthlyComments',
    now: Date = new Date(),
  ): Promise<WalletBalance | null> {
    const result = await this.balanceMany([workspaceId], meter, now);
    return result.get(workspaceId) ?? null;
  }

  /**
   * `balance()` for many workspaces in two queries (live subscriptions; balances joined to their
   * wallets), scoped by the given workspace ids and their accounts. Every requested id is in the
   * map; `null` = no live plan (or an unknown workspace).
   */
  async balanceMany(
    workspaceIds: readonly string[],
    meter: WalletMeter = 'monthlyComments',
    now: Date = new Date(),
  ): Promise<Map<string, WalletBalance | null>> {
    assertWalletInstant(now);
    const ids = [...new Set(workspaceIds)];
    const result = new Map<string, WalletBalance | null>(
      ids.map((id) => [id, null]),
    );
    const lives = await findLiveSubscriptions(this.db, ids, now);
    if (lives.size === 0) return result;
    const periods = new Map(
      [...lives.values()].map((live) => [
        live.workspaceId,
        subscriptionPeriod(live, now),
      ]),
    );
    const accounts = [
      ...new Set([...lives.values()].map((l) => l.billingAccountId)),
    ];
    const starts = [
      ...new Set([...periods.values()].map((p) => p.start.getTime())),
    ];
    const b = walletBalances;
    const rows = await this.db
      .select({
        billingAccountId: wallets.billingAccountId,
        periodStart: b.periodStart,
        periodEnd: b.periodEnd,
        included: b.included,
        added: b.added,
        used: b.used,
      })
      .from(b)
      .innerJoin(wallets, eq(wallets.id, b.walletId))
      .where(
        and(
          inArray(wallets.billingAccountId, accounts),
          eq(b.meter, meter),
          inArray(
            b.periodStart,
            starts.map((t) => new Date(t)),
          ),
        ),
      );
    const rowOf = new Map(
      rows.map((r) => [`${r.billingAccountId}|${r.periodStart.getTime()}`, r]),
    );
    for (const live of lives.values()) {
      const period = periods.get(live.workspaceId)!;
      const row = rowOf.get(
        `${live.billingAccountId}|${period.start.getTime()}`,
      );
      const included =
        row?.included ??
        meterGrant(meter, live.plan, live.status === 'TRIALING');
      const added = row?.added ?? 0;
      const used = row?.used ?? 0;
      result.set(live.workspaceId, {
        meter,
        included,
        added,
        used,
        available: Math.max(included + added - used, 0),
        periodStart: period.start,
        resetsAt: row?.periodEnd ?? period.end,
      });
    }
    return result;
  }

  /** The guarded use: `true` when the period's balance row had room (and was raised by `n`). */
  private async use(
    db: WalletExecutor,
    billingAccountId: string,
    meter: WalletMeter,
    periodStart: Date,
    n: number,
  ): Promise<boolean> {
    const b = walletBalances;
    const rows = await db
      .update(b)
      .set({ used: sql`${b.used} + ${n}` })
      .where(
        and(
          inArray(
            b.walletId,
            db
              .select({ id: wallets.id })
              .from(wallets)
              .where(eq(wallets.billingAccountId, billingAccountId)),
          ),
          eq(b.meter, meter),
          eq(b.periodStart, periodStart),
          sql`${b.used} + ${n} <= ${b.included} + ${b.added}`,
        ),
      )
      .returning({ id: b.id });
    return rows.length > 0;
  }

  /**
   * Opens `period` for the account (run inside the consume transaction): creates the wallet if
   * missing, moves its stored period forward (or to a new anchor: a new subscription), and
   * writes the period's balance rows for every registered meter with the grant at this moment +
   * one `PLAN_GRANT` entry each. Idempotent under concurrency (`on conflict`); an older period
   * never moves the stored one back.
   */
  private async writePeriod(
    tx: WalletExecutor,
    live: LiveSubscription,
    period: WalletPeriod,
  ): Promise<void> {
    const w = wallets;
    const account = live.billingAccountId;
    const values = {
      cycleAnchorAt: period.anchor,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    };
    const [upserted] = await tx
      .insert(w)
      .values({ billingAccountId: account, ...values })
      .onConflictDoUpdate({
        target: w.billingAccountId,
        set: { ...values, updatedAt: sql`now()` },
        setWhere: or(
          ne(w.cycleAnchorAt, period.anchor),
          sql`${w.currentPeriodStart} < ${period.start}`,
          and(
            eq(w.currentPeriodStart, period.start),
            ne(w.currentPeriodEnd, period.end),
          ),
        ),
      })
      .returning({ id: w.id });
    const walletId =
      upserted?.id ??
      (
        await tx
          .select({ id: w.id })
          .from(w)
          .where(eq(w.billingAccountId, account))
      )[0]!.id;

    const trialing = live.status === 'TRIALING';
    const granted = await tx
      .insert(walletBalances)
      .values(
        WALLET_METER_KEYS.map((meter) => ({
          walletId,
          meter,
          periodStart: period.start,
          periodEnd: period.end,
          included: meterGrant(meter, live.plan, trialing),
        })),
      )
      .onConflictDoNothing({
        target: [
          walletBalances.walletId,
          walletBalances.meter,
          walletBalances.periodStart,
        ],
      })
      .returning({
        meter: walletBalances.meter,
        included: walletBalances.included,
      });
    if (granted.length === 0) return;
    await tx.insert(walletEntries).values(
      granted.map((g) => ({
        walletId,
        meter: g.meter,
        periodStart: period.start,
        kind: 'PLAN_GRANT' as const,
        amount: g.included,
        reference: live.subscriptionId,
      })),
    );
    this.logger.debug(
      `wallet period opened account=${account} wallet=${walletId} subscription=${live.subscriptionId} meters=${granted.length}`,
    );
  }
}
