import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { Database } from '../db/database.js';
import {
  plans,
  subscriptions,
  workspaceMembers,
  workspaces,
  workspaceStatusAuditLogs,
} from '../db/schema/index.js';
import type { WalletService } from '../wallet/wallet.service.js';
import {
  AdminClientsService,
  type ClientItem,
} from './admin-clients.service.js';

const WS = '019a0000-0000-7000-8000-000000000001';
const ADMIN = '019a0000-0000-7000-8000-0000000000aa';
/** Wallet reads are not part of these tests. */
const NO_WALLET = {} as WalletService;

/** Just enough of a Drizzle transaction for `updateStatus`. */
function fakeDb(
  current: { id: string; status: 'ACTIVE' | 'SUSPENDED' } | undefined,
) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        expect(table).toBe(workspaces);
        return {
          where: () => ({
            for: async (mode: string) => {
              expect(mode).toBe('update');
              return current ? [current] : [];
            },
          }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: unknown) => ({
        where: async () => {
          updates.push({ table, patch });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        inserts.push({ table, values });
      },
    }),
  };
  let transactions = 0;
  const db = {
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => {
      transactions++;
      return fn(tx);
    },
  };
  return {
    db: db as unknown as Database,
    updates,
    inserts,
    transactions: () => transactions,
  };
}

function service(fake: ReturnType<typeof fakeDb>) {
  const svc = new AdminClientsService(fake.db, NO_WALLET);
  const item = { id: WS, status: 'SUSPENDED' } as ClientItem;
  vi.spyOn(svc, 'findOne').mockResolvedValue(item);
  return { svc, item };
}

describe('AdminClientsService.updateStatus', () => {
  const input = { status: 'SUSPENDED' as const, reason: 'Scam reports' };

  it('updates the status and writes one audit row in the same transaction', async () => {
    const fake = fakeDb({ id: WS, status: 'ACTIVE' });
    const { svc, item } = service(fake);
    await expect(svc.updateStatus(WS, input, ADMIN)).resolves.toEqual({
      client: item,
      changed: true,
    });
    expect(fake.transactions()).toBe(1);
    expect(fake.updates).toEqual([
      { table: workspaces, patch: { status: 'SUSPENDED' } },
    ]);
    expect(fake.inserts).toEqual([
      {
        table: workspaceStatusAuditLogs,
        values: {
          workspaceId: WS,
          adminId: ADMIN,
          oldStatus: 'ACTIVE',
          newStatus: 'SUSPENDED',
          reason: 'Scam reports',
        },
      },
    ]);
  });

  it('is an idempotent no-op (no update, no audit row) when the status is unchanged', async () => {
    const fake = fakeDb({ id: WS, status: 'SUSPENDED' });
    const { svc, item } = service(fake);
    await expect(svc.updateStatus(WS, input, ADMIN)).resolves.toEqual({
      client: item,
      changed: false,
    });
    expect(fake.updates).toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it('404s an unknown id without writing anything', async () => {
    const fake = fakeDb(undefined);
    const { svc } = service(fake);
    await expect(svc.updateStatus(WS, input, ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fake.updates).toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it('404s a malformed id before touching the database', async () => {
    const fake = fakeDb({ id: WS, status: 'ACTIVE' });
    const { svc } = service(fake);
    for (const bad of [
      'not-a-uuid',
      `${WS}x`,
      "'; drop table workspaces; --",
    ]) {
      await expect(svc.updateStatus(bad, input, ADMIN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    expect(fake.transactions()).toBe(0);
  });
});

describe('AdminClientsService.list', () => {
  it('400s an unknown plan slug before listing', async () => {
    const lookups: unknown[] = [];
    const db = {
      select: () => ({
        from: (table: unknown) => {
          lookups.push(table);
          return { where: () => ({ limit: async () => [] }) };
        },
      }),
    };
    const svc = new AdminClientsService(db as unknown as Database, NO_WALLET);
    await expect(
      svc.list({ skip: 0, take: 50, sort: 'newest', plan: 'platinum' }),
    ).rejects.toThrow(new BadRequestException('Unknown plan: platinum'));
    expect(lookups).toEqual([plans]);
  });

  it('400s when createdFrom is after createdTo, before querying', async () => {
    const svc = new AdminClientsService({} as Database, NO_WALLET);
    await expect(
      svc.list({
        skip: 0,
        take: 50,
        sort: 'newest',
        createdFrom: '2026-11-19',
        createdTo: '2026-11-18',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AdminClientsService client items: plan, subscription, comments (PW-T6b)', () => {
  const WS2 = '019a0000-0000-7000-8000-000000000002';
  const ACC = '019a0000-0000-7000-8000-0000000000c1';
  const SUB = '019a0000-0000-7000-8000-0000000000d1';
  const PLAN = '019a0000-0000-7000-8000-0000000000b1';
  const NOW = new Date('2026-11-20T06:00:00.000Z');
  const TERM_END = new Date('2026-12-15T06:00:00.000Z');
  // WS has an ACTIVE Growth subscription; WS2 has no billing account.
  const page = [WS, WS2].map((id) => ({
    id,
    name: `Shop ${id.slice(-1)}`,
    slug: `shop-${id.slice(-1)}`,
    status: 'ACTIVE' as const,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    billingAccountId: id === WS ? ACC : null,
  }));
  const liveRow = {
    workspaceId: WS,
    billingAccountId: ACC,
    subscriptionId: SUB,
    status: 'ACTIVE',
    interval: 'month',
    startedAt: new Date('2026-11-15T06:00:00.000Z'),
    trialEndsAt: null,
    currentTermStart: new Date('2026-11-15T06:00:00.000Z'),
    currentTermEnd: TERM_END,
    planId: PLAN,
    planSlug: 'growth',
    featureConfig: {},
    trialCommentLimit: null,
  };
  const summaryRow = {
    billingAccountId: ACC,
    id: SUB,
    status: 'ACTIVE',
    interval: 'month',
    trialEndsAt: null,
    currentTermEnd: TERM_END,
    planId: PLAN,
    planSlug: 'growth',
    planName: 'Growth',
  };

  /**
   * Just enough of the `findOne` queries: page rows (`…limit()`), owners (`…innerJoin…orderBy()`),
   * member counts (`…groupBy()`), live subscriptions (`workspaces` joined, awaited after
   * `where()`) and the described subscriptions (`selectDistinctOn`). Anything else throws.
   */
  function chainDb() {
    const queries: string[] = [];
    const chainFor = () => {
      let table: unknown;
      let joined = false;
      const chain: Record<string, (...args: unknown[]) => unknown> = {
        from: (t) => {
          table = t;
          return chain;
        },
        innerJoin: () => {
          joined = true;
          return chain;
        },
        // The live-subscription query's redemption snapshot (PR-T3).
        leftJoin: () => chain,
        // The live-subscription query is awaited right after `where()`.
        where: () => {
          if (table !== workspaces || !joined) return chain;
          queries.push('lives');
          return Promise.resolve([liveRow]);
        },
        limit: async () => {
          if (table === workspaces && !joined) return page;
          throw new Error('unexpected query');
        },
        orderBy: async () => {
          if (table === workspaceMembers && joined) {
            queries.push('owners');
            return [
              { workspaceId: WS, id: 'u1', email: 'o@x.test', name: 'O' },
            ];
          }
          if (table === subscriptions) {
            queries.push('summaries');
            return [summaryRow];
          }
          throw new Error('unexpected query');
        },
        groupBy: async () => {
          if (table === workspaceMembers) {
            queries.push('members');
            return [{ workspaceId: WS, total: 2 }];
          }
          throw new Error('unexpected query');
        },
      };
      return chain;
    };
    const db = { select: chainFor, selectDistinctOn: chainFor };
    return { db: db as unknown as Database, queries };
  }

  function make(wallet: Partial<WalletService>) {
    const { db, queries } = chainDb();
    const svc = new AdminClientsService(db, wallet as WalletService);
    svc.now = () => NOW;
    return { svc, queries };
  }

  it('maps the live plan, subscription and pooled comments; no account → nulls + zero comments', async () => {
    const balanceMany = vi.fn(
      async () =>
        new Map([
          [
            WS,
            {
              meter: 'monthlyComments' as const,
              included: 2500,
              added: 0,
              used: 1234,
              available: 1266,
              periodStart: new Date('2026-11-15T06:00:00.000Z'),
              resetsAt: TERM_END,
            },
          ],
          [WS2, null],
        ]),
    );
    const { svc, queries } = make({ balanceMany });
    const item = await svc.findOne(WS);
    expect(item).toEqual({
      id: WS,
      name: 'Shop 1',
      slug: 'shop-1',
      status: 'ACTIVE',
      createdAt: page[0]!.createdAt,
      owner: { id: 'u1', email: 'o@x.test', name: 'O' },
      memberCount: 2,
      plan: { id: PLAN, slug: 'growth', name: 'Growth' },
      subscription: {
        status: 'ACTIVE',
        interval: 'month',
        trialEndsAt: null,
        termEndsAt: TERM_END,
      },
      comments: { used: 1234, limit: 2500, resetsAt: TERM_END },
    });
    expect(item).not.toHaveProperty('credits');
    expect(item).not.toHaveProperty('billingAccountId');
    expect(balanceMany).toHaveBeenCalledWith([WS, WS2], 'monthlyComments', NOW);
    // Batched: one query each, no per-workspace lookups.
    expect(queries.toSorted()).toEqual([
      'lives',
      'members',
      'owners',
      'summaries',
    ]);
  });

  it('a failing wallet read → comments null, plan + subscription still answered, logged', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { svc } = make({
      balanceMany: vi.fn(async () => {
        throw new Error('connection terminated');
      }),
    });
    const item = await svc.findOne(WS);
    expect(item?.comments).toBeNull();
    expect(item?.plan?.slug).toBe('growth');
    expect(item?.subscription?.status).toBe('ACTIVE');
    expect(item?.memberCount).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      'Comment usage unavailable for 2 clients: Error',
    );
    warn.mockRestore();
  });
});
