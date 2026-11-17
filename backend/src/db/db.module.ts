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
      // A new TLS + SCRAM connection to Neon us-east-2 from Bangladesh takes ~2.5 s (≈350 ms RTT),
      // more after scale-to-zero, so 3 s timed out. Health checks keep their own 3 s cap.
      connectionTimeoutMillis: 10_000,
    },
    schema,
    casing: 'snake_case' as const,
  }),
});
