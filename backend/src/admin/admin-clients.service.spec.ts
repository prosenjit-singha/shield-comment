import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Database } from '../db/database.js';
import { workspaces, workspaceStatusAuditLogs } from '../db/schema/index.js';
import {
  AdminClientsService,
  type ClientItem,
} from './admin-clients.service.js';

const WS = '019a0000-0000-7000-8000-000000000001';
const ADMIN = '019a0000-0000-7000-8000-0000000000aa';

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
  const svc = new AdminClientsService(fake.db);
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
  it('400s when createdFrom is after createdTo, before querying', async () => {
    const svc = new AdminClientsService({} as Database);
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
