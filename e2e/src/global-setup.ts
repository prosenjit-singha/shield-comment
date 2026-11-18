import type { FullConfig } from '@playwright/test';
import { env, runIdentity } from './env.js';
import { cleanupRun, seedSuperAdminViaCompose, signUpOwner, userExists } from './stack.js';

/**
 * Seeds one super admin + one client owner (with their workspace) for this run. The run id goes into
 * `process.env.E2E_RUN_ID`, which the test workers and the global teardown inherit.
 * If seeding fails half-way, whatever was created is deleted before the error is rethrown.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const identity = runIdentity();
  process.env.E2E_RUN_ID = identity.runId;
  try {
    if (env.superAdminSeed === 'compose-exec') seedSuperAdminViaCompose(identity);
    if (!(await userExists(identity.superAdmin.email))) {
      throw new Error(
        `Super admin ${identity.superAdmin.email} not found (E2E_SUPER_ADMIN_SEED=${env.superAdminSeed}).`,
      );
    }
    await signUpOwner(identity);
  } catch (error) {
    await cleanupRun(identity).catch(() => undefined);
    throw error;
  }
}
