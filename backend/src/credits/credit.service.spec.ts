import type { Database } from '../db/database.js';
import { CreditService } from './credit.service.js';

/** A db whose every query builder call fails the spec (no SQL expected). */
function strictDb(): Database {
  const fail = vi.fn(() => {
    throw new Error('unexpected query');
  });
  return { select: fail, insert: fail, update: fail } as unknown as Database;
}

describe('CreditService (unit)', () => {
  it('rejects a bad cost before any query', async () => {
    const service = new CreditService(strictDb());
    const limit = vi.spyOn(service, 'monthlyLimit');
    for (const cost of [0, -1, 1.5, Number.NaN]) {
      await expect(service.reserve('ws', cost)).rejects.toThrow(RangeError);
      await expect(service.release('ws', cost)).rejects.toThrow(RangeError);
    }
    expect(limit).not.toHaveBeenCalled();
  });

  it('refuses without an upsert when the cost alone is above the limit', async () => {
    const service = new CreditService(strictDb());
    vi.spyOn(service, 'monthlyLimit').mockResolvedValue(1);
    await expect(service.reserve('ws', 2)).resolves.toBe(false);
    vi.spyOn(service, 'monthlyLimit').mockResolvedValue(0);
    await expect(service.reserve('ws', 1)).resolves.toBe(false);
  });

  it('rejects an invalid instant', async () => {
    const service = new CreditService(strictDb());
    vi.spyOn(service, 'monthlyLimit').mockResolvedValue(10);
    await expect(service.reserve('ws', 1, new Date('x'))).rejects.toThrow(
      RangeError,
    );
  });

  it('usageMany: no ids → empty map without a query; a bad instant → RangeError', async () => {
    const service = new CreditService(strictDb());
    await expect(service.usageMany([])).resolves.toEqual(new Map());
    await expect(service.usageMany(['ws'], new Date('x'))).rejects.toThrow(
      RangeError,
    );
  });
});
