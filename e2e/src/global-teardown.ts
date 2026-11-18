import type { FullConfig } from '@playwright/test';
import { runIdentity } from './env.js';
import { assertRunGone, cleanupRun } from './stack.js';

/** Deletes everything the run created (Postgres rows + Better Auth Redis keys) and checks nothing is left. */
export default async function globalTeardown(_config: FullConfig): Promise<void> {
  const identity = runIdentity();
  const summary = await cleanupRun(identity);
  await assertRunGone(identity, summary.userIds);
  console.log(
    `[e2e] cleanup run ${identity.runId}: ${summary.users} users, ${summary.workspaces} workspaces, ` +
      `${summary.auditRows} audit rows, ${summary.redisKeys} redis keys deleted`,
  );
}
