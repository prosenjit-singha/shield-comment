/**
 * Drizzle schema barrel: one file per area (`auth.ts`, `workspaces.ts`, …), re-exported here.
 * Both `drizzle()` (src/db/db.module.ts) and drizzle-kit (drizzle.config.ts) read this file.
 */
export * from './auth.js';
export * from './plans.js';
export * from './workspaces.js';
export * from './impersonation.js';
export * from './workspace-status-audit.js';
export * from './support-tickets.js';
export * from './plan-audit.js';
export * from './meta.js';
export * from './comments.js';
export * from './meta-data-deletion.js';
export * from './ai-settings.js';
export * from './moderation.js';
