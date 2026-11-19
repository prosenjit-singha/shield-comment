import type { SecondaryStorage } from 'better-auth';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createBetterAuth } from '../auth/better-auth.js';
import { LimitService } from '../billing/limit.service.js';
import { SubscriptionService } from '../billing/subscription.service.js';
import { PasswordService } from '../auth/password.service.js';
import { ensureSuperAdmin, parseSuperAdminInput } from '../auth/super-admin.js';
import { relaxHappyEyeballsTimeout } from '../common/net/happy-eyeballs.js';
import * as schema from '../db/schema/index.js';
import { WalletService } from '../wallet/wallet.service.js';

/**
 * `npm run create-super-admin` (after `npm run build`): creates or promotes the platform super admin.
 *   SUPER_ADMIN_EMAIL=… SUPER_ADMIN_PASSWORD=… [SUPER_ADMIN_NAME=…] npm run create-super-admin
 *   npm run create-super-admin -- --email=… --name=…   (password still best via env)
 * Needs DATABASE_URL and BETTER_AUTH_SECRET (from backend/.env). Safe to re-run.
 */

/** Creating a user touches no session data, so Redis isn't needed. */
function noopStorage(): SecondaryStorage {
  const store = new Map<string, string>();
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => void store.set(key, value),
    delete: (key) => void store.delete(key),
    getAndDelete: (key) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    increment: (key) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

relaxHappyEyeballsTimeout();
let pool: Pool | undefined;
try {
  const input = parseSuperAdminInput(process.argv.slice(2), process.env);
  pool = new Pool({
    connectionString: requireEnv('DATABASE_URL'),
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  const auth = createBetterAuth(db, {
    secret: requireEnv('BETTER_AUTH_SECRET'),
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    trustedOrigins: [],
    passwords: new PasswordService(),
    secondaryStorage: noopStorage(),
    rateLimit: false,
    // `createUser` makes no session or workspace, so the billing hooks never run here.
    billing: new SubscriptionService(db, new WalletService(db)),
    limits: new LimitService(db),
  });
  const result = await ensureSuperAdmin(db, auth, input);
  const messages = {
    created: `Created super admin ${input.email}`,
    promoted: `Promoted ${input.email} to super admin (password unchanged; sign in again)`,
    unchanged: `${input.email} is already a super admin (nothing changed)`,
  } as const;
  console.log(messages[result]);
} catch (error) {
  console.error(
    `create-super-admin failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
