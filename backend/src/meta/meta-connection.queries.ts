import { sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { metaConnections } from '../db/schema/index.js';

/** A database or a transaction (M3-T5 runs this in one tx with the Page sync). */
export type DbExecutor = Pick<Database, 'insert'>;

export interface MetaConnectionUpsert {
  workspaceId: string;
  facebookUserId: string;
  /** `TokenCipherService` ciphertext, never plaintext (the DB check rejects plaintext too). */
  encryptedUserAccessToken: string;
  tokenExpiresAt: Date | null;
  grantedScopes: string[];
}

/**
 * Creates the workspace's connection or replaces it in place (D7: one per workspace, re-connect =
 * upsert on `workspace_id`). Always ends `ACTIVE`; `status_changed_at` moves only when the status
 * actually changes (e.g. NEEDS_REAUTH → ACTIVE after a reconnect). Returns the row id, no token.
 */
export async function upsertMetaConnection(
  db: DbExecutor,
  values: MetaConnectionUpsert,
  now = new Date(),
): Promise<{ id: string }> {
  const [row] = await db
    .insert(metaConnections)
    .values({
      ...values,
      status: 'ACTIVE',
      statusChangedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: metaConnections.workspaceId,
      set: {
        facebookUserId: values.facebookUserId,
        encryptedUserAccessToken: values.encryptedUserAccessToken,
        tokenExpiresAt: values.tokenExpiresAt,
        grantedScopes: values.grantedScopes,
        status: 'ACTIVE',
        statusChangedAt: sql`case when ${metaConnections.status} = 'ACTIVE' then ${metaConnections.statusChangedAt} else ${now} end`,
        updatedAt: now,
      },
    })
    .returning({ id: metaConnections.id });
  if (!row) throw new Error('Meta connection upsert returned no row');
  return row;
}
