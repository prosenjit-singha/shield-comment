import type { FullConfig } from '@playwright/test';
import { env, runIdentity, seedsThisRun, smokeLocalSeed } from './env.js';

/**
 * Seeds one super admin + one client owner (with their workspace) for this run and, on host runs,
 * starts the Module 6 gate's `backend-e2e` (Graph stub as Meta host). The run id goes into
 * `process.env.E2E_RUN_ID`, which the test workers and the global teardown inherit.
 * If seeding fails half-way, whatever was created is deleted before the error is rethrown.
 * `npm run smoke:local` also exports the run's users as SMOKE_* env for the `smoke` project.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  if (!seedsThisRun(config)) return;
  // Loaded only when seeding: a plain smoke run never imports pg / ioredis.
  const { cleanupRun, removeStubBackend, seedSuperAdminViaCompose, signUpOwner, startStubBackend, userExists } =
    await import('./stack.js');
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
    if (env.stubBackend === 'compose-up') startStubBackend();
    if (smokeLocalSeed()) {
      Object.assign(process.env, {
        SMOKE_CLIENT_URL: env.clientUrl,
        SMOKE_ADMIN_URL: env.adminUrl,
        SMOKE_API_URL: env.apiUrl,
        SMOKE_OWNER_EMAIL: identity.owner.email,
        SMOKE_OWNER_PASSWORD: env.ownerPassword,
        SMOKE_ADMIN_EMAIL: identity.superAdmin.email,
        SMOKE_ADMIN_PASSWORD: env.superAdminPassword,
      });
    }
  } catch (error) {
    await cleanupRun(identity).catch(() => undefined);
    if (env.stubBackend === 'compose-up') {
      try {
        removeStubBackend();
      } catch {
        // The original error matters more.
      }
    }
    throw error;
  }
}
