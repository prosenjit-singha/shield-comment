import type { FullConfig } from '@playwright/test';
import { env, runIdentity, seedsThisRun } from './env.js';

/**
 * Deletes everything the run created (Postgres rows + Better Auth Redis keys) and checks nothing is
 * left; on host runs also removes `backend-e2e` (Docker runs: `npm run test:docker` removes it).
 */
export default async function globalTeardown(config: FullConfig): Promise<void> {
  if (!seedsThisRun(config)) return;
  const { assertRunGone, cleanupRun, removeStubBackend } = await import('./stack.js');
  const identity = runIdentity();
  try {
    // First, so no second API process writes while the rows go.
    if (env.stubBackend === 'compose-up') removeStubBackend();
  } finally {
    const summary = await cleanupRun(identity);
    await assertRunGone(identity, summary.userIds);
    console.log(
      `[e2e] cleanup run ${identity.runId}: ${summary.users} users, ${summary.workspaces} workspaces, ` +
        `${summary.auditRows} audit rows, ${summary.redisKeys} redis keys deleted`,
    );
  }
}
