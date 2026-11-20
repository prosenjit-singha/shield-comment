import { BadRequestException } from '@nestjs/common';
import type { Database } from '../db/database.js';
import { AdminPlansService } from './admin-plans.service.js';

const ADMIN = '019a0000-0000-7000-8000-0000000000ad';
const SAVED_AT = new Date('2026-11-20T04:00:00.000Z');

/** Captures the upsert: `insert().values().onConflictDoUpdate({ set }).returning()`. */
function upsertDb(row: object) {
  const calls: { values?: object; set?: object } = {};
  const db = {
    insert: () => ({
      values: (values: object) => {
        calls.values = values;
        return {
          onConflictDoUpdate: ({ set }: { set: object }) => {
            calls.set = set;
            return { returning: async () => [row] };
          },
        };
      },
    }),
  };
  return { service: new AdminPlansService(db as unknown as Database), calls };
}

describe('AdminPlansService.updatePlatformSettings (M6-T7b)', () => {
  it('an empty patch → 400 Nothing to update, no write', async () => {
    const { service, calls } = upsertDb({});
    await expect(service.updatePlatformSettings({}, ADMIN)).rejects.toThrow(
      new BadRequestException('Nothing to update'),
    );
    expect(calls).toEqual({});
  });

  it('only the limit: the WhatsApp number is left out of insert and update', async () => {
    const { service, calls } = upsertDb({
      supportWhatsappNumber: '8801712345678',
      playgroundDailyLimit: 25,
      updatedAt: SAVED_AT,
    });
    await expect(
      service.updatePlatformSettings({ playgroundDailyLimit: 25 }, ADMIN),
    ).resolves.toEqual({
      supportWhatsappNumber: '8801712345678',
      playgroundDailyLimit: 25,
      updatedAt: SAVED_AT.toISOString(),
    });
    expect(calls.values).toEqual({
      id: 1,
      playgroundDailyLimit: 25,
      updatedById: ADMIN,
    });
    expect(calls.set).toEqual({
      playgroundDailyLimit: 25,
      updatedById: ADMIN,
      updatedAt: expect.any(Date) as Date,
    });
  });

  it('only the number (null clears it): the limit is left out', async () => {
    const { service, calls } = upsertDb({
      supportWhatsappNumber: null,
      playgroundDailyLimit: 10,
      updatedAt: SAVED_AT,
    });
    await service.updatePlatformSettings(
      { supportWhatsappNumber: null },
      ADMIN,
    );
    expect(calls.values).toEqual({
      id: 1,
      supportWhatsappNumber: null,
      updatedById: ADMIN,
    });
  });
});
