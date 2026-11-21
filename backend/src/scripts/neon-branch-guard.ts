import { checkNeonBranch } from '../config/neon-branch.js';

// Preloaded (`node --import ./dist/scripts/neon-branch-guard.js …`) by the staging/production npm
// scripts after the env files are loaded and before any module opens a connection.
const error = checkNeonBranch(process.env);
if (error) {
  console.error(`neon-branch-guard: ${error}. Nothing was run.`);
  process.exit(1);
}
