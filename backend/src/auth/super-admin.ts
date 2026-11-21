import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { users } from '../db/schema/index.js';
import type { BetterAuth } from './better-auth.js';
import { SUPER_ADMIN_ROLE } from './guards/super-admin.guard.js';

export interface SuperAdminInput {
  email: string;
  password?: string;
  name: string;
}

export type SuperAdminResult = 'created' | 'promoted' | 'unchanged';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;

/**
 * `--email/--password/--name` args win over `SUPER_ADMIN_EMAIL/_PASSWORD/_NAME` env vars.
 * Prefer the env var for the password (args show up in the process list / shell history).
 */
export function parseSuperAdminInput(
  argv: string[],
  env: NodeJS.ProcessEnv,
): SuperAdminInput {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string' },
    },
    strict: true,
  });
  const email = (values.email ?? env.SUPER_ADMIN_EMAIL ?? '')
    .trim()
    .toLowerCase();
  if (!EMAIL.test(email)) {
    throw new Error(
      'Set SUPER_ADMIN_EMAIL (or --email) to a valid email address',
    );
  }
  const password = values.password ?? env.SUPER_ADMIN_PASSWORD ?? undefined;
  if (password !== undefined && password.length < PASSWORD_MIN) {
    throw new Error(`The password must be at least ${PASSWORD_MIN} characters`);
  }
  const name =
    (values.name ?? env.SUPER_ADMIN_NAME ?? '').trim() || 'Super Admin';
  return { email, password: password || undefined, name };
}

/**
 * Idempotent: creates the user as `super_admin` through Better Auth's admin API (password hashed
 * with argon2id by `PasswordService`; no workspace, no session), or promotes an existing user.
 * Both are marked email-verified (M9-T5: sign-in requires it; the operator vouches for the address).
 * An existing user's password and name are never changed. Promoted users must sign in again:
 * their cached sessions still carry the old role.
 */
export async function ensureSuperAdmin(
  db: Database,
  auth: Pick<BetterAuth, 'api'>,
  input: SuperAdminInput,
): Promise<SuperAdminResult> {
  const [existing] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  if (existing) {
    if (existing.role === SUPER_ADMIN_ROLE) return 'unchanged';
    await db
      .update(users)
      .set({ role: SUPER_ADMIN_ROLE, emailVerified: true })
      .where(eq(users.id, existing.id));
    return 'promoted';
  }

  if (!input.password) {
    throw new Error(
      `No user ${input.email} yet: set SUPER_ADMIN_PASSWORD (or --password) to create it`,
    );
  }
  // No request headers = trusted server call, so no admin session is needed.
  await auth.api.createUser({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
      role: SUPER_ADMIN_ROLE,
      data: { emailVerified: true },
    },
  });
  return 'created';
}
