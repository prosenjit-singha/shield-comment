/**
 * Drizzle schema barrel: one file per area (`auth.ts`, `workspaces.ts`, …), re-exported here.
 * Both `drizzle()` (src/db/db.module.ts) and drizzle-kit (drizzle.config.ts) read this file.
 */
export * from './auth.js';
export * from './workspaces.js';
export * from './impersonation.js';
