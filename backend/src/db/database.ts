import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

/** The app's Drizzle database. Inject with `@InjectDrizzle()` from `@nestjs/drizzle`. */
export type Database = NodePgDatabase<typeof schema>;
