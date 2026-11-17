import { ConfigService } from '@nestjs/config';
import { DrizzleModule } from '@nestjs/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { EnvironmentVariables } from '../config/env.validation.js';
import * as schema from './schema/index.js';

/**
 * Global Drizzle database (node-postgres `Pool` on `DATABASE_URL`, snake_case casing).
 * `@nestjs/drizzle` closes the pool on shutdown. Inject with `@InjectDrizzle() db: Database`.
 */
export const DbModule = DrizzleModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
    drizzle,
    connection: {
      connectionString: config.get('DATABASE_URL', { infer: true }),
      connectionTimeoutMillis: 3000,
    },
    schema,
    casing: 'snake_case' as const,
  }),
});
