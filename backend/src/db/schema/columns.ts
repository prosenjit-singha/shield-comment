import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/**
 * Shared column builders so every table follows the same conventions
 * (docs/project-documentation/tech-stack.md §6). Column names come from the TS key and
 * become snake_case through `casing: 'snake_case'` (set in `drizzle()` and `drizzle.config.ts`).
 */

/** UUIDv7 primary key, made by the app (time-ordered, so inserts stay index-friendly). */
export const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** `timestamptz(3)`. */
export const timestamptz = () => timestamp({ withTimezone: true, precision: 3, mode: 'date' });

/** `createdAt` / `updatedAt` pair. `updatedAt` is refreshed by Drizzle on every update. */
export const timestamps = {
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
