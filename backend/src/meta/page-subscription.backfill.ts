import { setTimeout as sleep } from 'node:timers/promises';
import type { Database } from '../db/database.js';
import { listActivePagesWithToken } from './page-subscription.queries.js';
import type { PageSubscriptionService } from './page-subscription.service.js';

export interface PageSubscriptionBackfillCounts {
  /** Active Pages with a token that were read. */
  pages: number;
  subscribed: number;
  failed: number;
  undecryptable: number;
  /** Connections moved ACTIVE → NEEDS_REAUTH because Graph rejected a Page token. */
  connectionsMarkedNeedsReauth: number;
  /** Not attempted because Meta rate-limited the run (re-run later). */
  notAttempted: number;
}

export type PageSubscriptionBackfillResult =
  | { kind: 'skipped'; reason: 'not_configured' }
  | { kind: 'done'; counts: PageSubscriptionBackfillCounts };

export interface PageSubscriptionBackfillOptions {
  /** Pause between Graph calls (default 200 ms, like the token check). */
  delayMs?: number;
  pageSize?: number;
  wait?: (ms: number) => Promise<unknown>;
}

/**
 * One-off backfill (M4-T8, Module 4 D10): `subscribed_apps` for every Page that was switched on
 * before the toggle subscribed (Module 3). Idempotent (Meta treats a repeat subscribe as a no-op),
 * sequential with a small delay; `token_invalid` marks the connection NEEDS_REAUTH like the toggle.
 * A rate limit stops the run (the rest is counted `notAttempted`). System-wide read of active
 * Pages; the only write (NEEDS_REAUTH) is scoped by `workspace_id` + Page row id.
 */
export async function backfillPageSubscriptions(
  db: Database,
  subscriptions: PageSubscriptionService,
  options: PageSubscriptionBackfillOptions = {},
): Promise<PageSubscriptionBackfillResult> {
  if (!subscriptions.configured) {
    return { kind: 'skipped', reason: 'not_configured' };
  }
  const delayMs = options.delayMs ?? 200;
  const pageSize = options.pageSize ?? 100;
  const wait = options.wait ?? sleep;
  const counts: PageSubscriptionBackfillCounts = {
    pages: 0,
    subscribed: 0,
    failed: 0,
    undecryptable: 0,
    connectionsMarkedNeedsReauth: 0,
    notAttempted: 0,
  };
  let rateLimited = false;
  let calls = 0;
  let afterId: string | null = null;
  for (;;) {
    const rows = await listActivePagesWithToken(db, afterId, pageSize);
    for (const row of rows) {
      afterId = row.id;
      counts.pages++;
      if (rateLimited || row.encryptedPageAccessToken === null) {
        counts.notAttempted++;
        continue;
      }
      if (calls > 0 && delayMs > 0) await wait(delayMs);
      calls++;
      const result = await subscriptions.subscribe({
        ...row,
        encryptedPageAccessToken: row.encryptedPageAccessToken,
      });
      if (result.kind === 'subscribed') counts.subscribed++;
      else if (result.kind === 'undecryptable') counts.undecryptable++;
      else {
        counts.failed++;
        if (result.connectionMarked) counts.connectionsMarkedNeedsReauth++;
        if (result.errorKind === 'rate_limited') rateLimited = true;
      }
    }
    if (rows.length < pageSize) break;
  }
  return { kind: 'done', counts };
}
