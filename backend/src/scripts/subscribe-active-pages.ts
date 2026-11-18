import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { relaxHappyEyeballsTimeout } from '../common/net/happy-eyeballs.js';
import {
  type EnvironmentVariables,
  validateEnv,
} from '../config/env.validation.js';
import { createTokenKeyring } from '../crypto/token-cipher.config.js';
import { TokenCipherService } from '../crypto/token-cipher.service.js';
import * as schema from '../db/schema/index.js';
import { MetaGraphClient } from '../meta/meta-graph.client.js';
import { createMetaAppConfig } from '../meta/meta-graph.config.js';
import { backfillPageSubscriptions } from '../meta/page-subscription.backfill.js';
import { PageSubscriptionService } from '../meta/page-subscription.service.js';

/**
 * `npm run meta:subscribe-pages` (after `npm run build`): one-off backfill (M4-T8, Module 4 D10)
 * that calls Graph `subscribed_apps` for every active Page that holds a token (Pages switched on
 * in Module 3, before the toggle subscribed). Safe to re-run. Prints counts only, never tokens.
 * Needs the backend env (DATABASE_URL, META_*, TOKEN_ENCRYPTION_*); without META_* or the cipher
 * it exits 0 with "skipped". Exit 1 when a Page failed or Meta rate-limited the run.
 *   host:    cd backend && npm run build && npm run meta:subscribe-pages
 *   compose: docker compose exec backend node dist/scripts/subscribe-active-pages.js
 */
relaxHappyEyeballsTimeout();
let pool: Pool | undefined;
try {
  const env = validateEnv(process.env);
  const config = new ConfigService<EnvironmentVariables, true>(env);
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  const subscriptions = new PageSubscriptionService(
    db,
    new MetaGraphClient(createMetaAppConfig(config)),
    new TokenCipherService(createTokenKeyring(config)),
  );
  const result = await backfillPageSubscriptions(db, subscriptions);
  if (result.kind === 'skipped') {
    console.log(
      'Skipped: the Meta app (META_*) or the token cipher (TOKEN_ENCRYPTION_*) is not configured',
    );
  } else {
    const c = result.counts;
    console.log(
      `Active Pages: ${c.pages} · subscribed: ${c.subscribed} · failed: ${c.failed} · undecryptable: ${c.undecryptable} · connections → NEEDS_REAUTH: ${c.connectionsMarkedNeedsReauth} · not attempted (rate limit): ${c.notAttempted}`,
    );
    if (c.failed > 0 || c.undecryptable > 0 || c.notAttempted > 0) {
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(
    `meta:subscribe-pages failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
