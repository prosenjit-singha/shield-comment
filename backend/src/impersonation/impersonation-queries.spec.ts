import { drizzle } from 'drizzle-orm/node-postgres';
import type { Database } from '../db/database.js';
import {
  burnImpersonationTokenQuery,
  redeemImpersonationToken,
} from './impersonation-queries.js';
import {
  generateImpersonationToken,
  hashImpersonationToken,
  impersonationTokenExpiry,
} from './impersonation-token.js';

interface Row {
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * Just enough of Drizzle for `redeemImpersonationToken`: the UPDATE applies the same rules as the
 * real WHERE (checked separately against the generated SQL below).
 */
function fakeDb(rows: Row[]) {
  const find = () => rows[0];
  const db = {
    update: () => ({
      set: (patch: { usedAt: Date }) => ({
        where: () => ({
          returning: async () => {
            const row = find();
            if (!row || row.usedAt || row.expiresAt <= patch.usedAt) return [];
            row.usedAt = patch.usedAt;
            return [
              {
                auditId: 'audit-1',
                adminId: 'admin-1',
                targetWorkspaceId: 'ws-1',
              },
            ];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (find() ? [{ ...find()! }] : []) }),
      }),
    }),
  };
  return db as unknown as Database;
}

describe('redeemImpersonationToken', () => {
  const issued = new Date('2026-11-18T10:00:00.000Z');
  const token = generateImpersonationToken();
  const row = (): Row => ({
    tokenHash: hashImpersonationToken(token),
    expiresAt: impersonationTokenExpiry(issued),
    usedAt: null,
  });

  it('burns a fresh token once; a second exchange is rejected as used', async () => {
    const rows = [row()];
    const now = new Date(issued.getTime() + 5_000);
    await expect(
      redeemImpersonationToken(fakeDb(rows), token, now),
    ).resolves.toEqual({
      ok: true,
      auditId: 'audit-1',
      adminId: 'admin-1',
      targetWorkspaceId: 'ws-1',
    });
    expect(rows[0]!.usedAt).toEqual(now);
    await expect(
      redeemImpersonationToken(
        fakeDb(rows),
        token,
        new Date(now.getTime() + 1),
      ),
    ).resolves.toEqual({ ok: false, reason: 'used' });
  });

  it('rejects an expired token without marking it used', async () => {
    const rows = [row()];
    const now = new Date(issued.getTime() + 60_000);
    await expect(
      redeemImpersonationToken(fakeDb(rows), token, now),
    ).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(rows[0]!.usedAt).toBeNull();
  });

  it('rejects an unknown token', async () => {
    await expect(
      redeemImpersonationToken(fakeDb([]), token, issued),
    ).resolves.toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('the burn is one guarded UPDATE: by hash, unused, not expired, setting used_at', () => {
    const db = drizzle.mock({ casing: 'snake_case' }) as unknown as Database;
    const hash = hashImpersonationToken(token);
    const now = new Date(issued.getTime() + 1_000);
    const { sql, params } = burnImpersonationTokenQuery(db, hash, now).toSQL();
    expect(sql).toMatch(
      /^update "impersonation_audit_logs" set "used_at" = \$1, "updated_at" = \$2/,
    );
    expect(sql).toContain(
      'where ("impersonation_audit_logs"."token_hash" = $3 and "impersonation_audit_logs"."used_at" is null and "impersonation_audit_logs"."expires_at" > $4)',
    );
    expect(sql).toMatch(/returning "id", "admin_id", "target_workspace_id"$/);
    expect(params[2]).toBe(hash);
    expect(params).not.toContain(token);
  });
});
