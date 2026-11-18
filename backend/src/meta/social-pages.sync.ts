import { and, eq, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { socialPages } from '../db/schema/index.js';

/**
 * Page sync on Meta connect (M3-T5; user decisions D7/D10 2026-11-18, see docs/progress/TASKS.md).
 * Runs inside the callback's transaction, right after `upsertMetaConnection` (which takes the row
 * lock on the workspace's connection, so two callbacks of one workspace never sync at once).
 *
 * - D10: a Page seen for the first time is stored **inactive**; the user switches it on (M3-T6).
 *   A Page already in this workspace keeps its `is_active` (re-sync never switches it off) and gets
 *   the fresh name, IG account and Page token.
 * - D7: `page_id` / `ig_business_id` are globally unique. A Page, or a Page whose IG account,
 *   already belongs to **another** workspace is skipped with a reason, never moved or overwritten
 *   (a Page of this workspace whose IG account is held elsewhere is left exactly as it was).
 * - D7: Pages of this workspace missing from `/me/accounts` keep their row (and ids) but become
 *   `is_active = false` with the Page token cleared.
 * - An IG account that moved between two Pages of this workspace is detached from the old row first.
 *
 * The ownership read below is the one query not scoped by `workspace_id`: it must see other
 * workspaces' rows to refuse them, and it reads ids only (never names or tokens).
 */

/** A database or a transaction. */
export type PageSyncExecutor = Pick<Database, 'select' | 'insert' | 'update'>;

/** One `/me/accounts` Page, its token already encrypted for this workspace + Page. */
export interface SocialPageSyncInput {
  pageId: string;
  pageName: string;
  igBusinessId: string | null;
  igUsername: string | null;
  /** `tokenCipherContext('meta_page_token', workspaceId, pageId)` ciphertext. */
  encryptedPageAccessToken: string;
}

/**
 * - `page_in_other_workspace`: the Page is connected to another workspace.
 * - `instagram_in_other_workspace`: the Page's IG Business account is connected to another workspace.
 * - `duplicate_instagram`: Meta listed the same IG account on two Pages (first one wins).
 */
export const PAGE_SYNC_SKIP_REASONS = [
  'page_in_other_workspace',
  'instagram_in_other_workspace',
  'duplicate_instagram',
] as const;
export type PageSyncSkipReason = (typeof PAGE_SYNC_SKIP_REASONS)[number];

export interface SkippedPage {
  pageId: string;
  reason: PageSyncSkipReason;
}

export interface PageSyncResult {
  created: number;
  updated: number;
  /** Rows of this workspace missing from `/me/accounts` that were switched off / lost their token. */
  deactivated: number;
  skipped: SkippedPage[];
}

/** Ownership of an existing row (no name, no token). */
export interface ExistingPageOwnership {
  id: string;
  workspaceId: string;
  pageId: string;
  igBusinessId: string | null;
}

export interface PageSyncPlan {
  upserts: SocialPageSyncInput[];
  skipped: SkippedPage[];
  /** Rows of this workspace whose IG account now belongs to another of its Pages. */
  detachIgRowIds: string[];
  /** Every Page id Meta listed (rows of this workspace outside it are "missing"). */
  listedPageIds: string[];
}

/** Pure decision step (unit tested); `syncSocialPages` applies it. */
export function planPageSync(
  workspaceId: string,
  pages: readonly SocialPageSyncInput[],
  existing: readonly ExistingPageOwnership[],
): PageSyncPlan {
  const ws = workspaceId.toLowerCase();
  const ownsRow = (row: ExistingPageOwnership) =>
    row.workspaceId.toLowerCase() === ws;
  const byPageId = new Map(existing.map((row) => [row.pageId, row]));
  const byIgId = new Map(
    existing
      .filter((row) => row.igBusinessId !== null)
      .map((row) => [row.igBusinessId!, row]),
  );

  const upserts: SocialPageSyncInput[] = [];
  const skipped: SkippedPage[] = [];
  const listed = new Set<string>();
  /** IG id → Page id that carries it in this sync. */
  const claimedIg = new Map<string, string>();

  for (const page of pages) {
    if (listed.has(page.pageId)) continue; // Meta paging repeated a Page: first copy wins.
    listed.add(page.pageId);

    const pageOwner = byPageId.get(page.pageId);
    if (pageOwner && !ownsRow(pageOwner)) {
      skipped.push({ pageId: page.pageId, reason: 'page_in_other_workspace' });
      continue;
    }
    if (page.igBusinessId !== null) {
      const igOwner = byIgId.get(page.igBusinessId);
      if (igOwner && !ownsRow(igOwner)) {
        skipped.push({
          pageId: page.pageId,
          reason: 'instagram_in_other_workspace',
        });
        continue;
      }
      if (claimedIg.has(page.igBusinessId)) {
        skipped.push({ pageId: page.pageId, reason: 'duplicate_instagram' });
        continue;
      }
      claimedIg.set(page.igBusinessId, page.pageId);
    }
    upserts.push(page);
  }

  const detachIgRowIds = existing
    .filter(
      (row) =>
        ownsRow(row) &&
        row.igBusinessId !== null &&
        claimedIg.has(row.igBusinessId) &&
        claimedIg.get(row.igBusinessId) !== row.pageId,
    )
    .map((row) => row.id);

  return { upserts, skipped, detachIgRowIds, listedPageIds: [...listed] };
}

/**
 * Applies the plan in the caller's transaction. Throws on DB errors (the caller rolls back the
 * connection with it). Returns counts + skipped Page ids (no tokens).
 */
export async function syncSocialPages(
  db: PageSyncExecutor,
  workspaceId: string,
  pages: readonly SocialPageSyncInput[],
  now = new Date(),
): Promise<PageSyncResult> {
  const pageIds = [...new Set(pages.map((p) => p.pageId))];
  const igIds = [
    ...new Set(
      pages.flatMap((p) => (p.igBusinessId === null ? [] : [p.igBusinessId])),
    ),
  ];
  const existing = await db
    .select({
      id: socialPages.id,
      workspaceId: socialPages.workspaceId,
      pageId: socialPages.pageId,
      igBusinessId: socialPages.igBusinessId,
    })
    .from(socialPages)
    .where(
      or(
        eq(socialPages.workspaceId, workspaceId),
        ...(pageIds.length > 0 ? [inArray(socialPages.pageId, pageIds)] : []),
        ...(igIds.length > 0 ? [inArray(socialPages.igBusinessId, igIds)] : []),
      ),
    );

  const plan = planPageSync(workspaceId, pages, existing);
  const skipped = [...plan.skipped];

  if (plan.detachIgRowIds.length > 0) {
    await db
      .update(socialPages)
      .set({ igBusinessId: null, igUsername: null, updatedAt: now })
      .where(
        and(
          eq(socialPages.workspaceId, workspaceId),
          inArray(socialPages.id, plan.detachIgRowIds),
        ),
      );
  }

  let created = 0;
  let updated = 0;
  if (plan.upserts.length > 0) {
    const known = new Set(
      existing
        .filter(
          (r) => r.workspaceId.toLowerCase() === workspaceId.toLowerCase(),
        )
        .map((r) => r.pageId),
    );
    const written = await db
      .insert(socialPages)
      .values(
        plan.upserts.map((page) => ({
          ...page,
          workspaceId,
          isActive: false, // D10: new Pages start off.
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: socialPages.pageId,
        // `is_active` is not in the set: re-sync keeps the user's choice.
        set: {
          pageName: sql`excluded.page_name`,
          igBusinessId: sql`excluded.ig_business_id`,
          igUsername: sql`excluded.ig_username`,
          encryptedPageAccessToken: sql`excluded.encrypted_page_access_token`,
          updatedAt: now,
        },
        // Never take over a row another workspace inserted after the ownership read.
        setWhere: eq(socialPages.workspaceId, workspaceId),
      })
      .returning({ pageId: socialPages.pageId });
    const writtenIds = new Set(written.map((r) => r.pageId));
    for (const page of plan.upserts) {
      if (!writtenIds.has(page.pageId)) {
        skipped.push({
          pageId: page.pageId,
          reason: 'page_in_other_workspace',
        });
      } else if (known.has(page.pageId)) {
        updated += 1;
      } else {
        created += 1;
      }
    }
  }

  const missing = await db
    .update(socialPages)
    .set({ isActive: false, encryptedPageAccessToken: null, updatedAt: now })
    .where(
      and(
        eq(socialPages.workspaceId, workspaceId),
        ...(plan.listedPageIds.length > 0
          ? [notInArray(socialPages.pageId, plan.listedPageIds)]
          : []),
        // Only rows that actually change (keeps `updated_at` and the count honest).
        or(
          eq(socialPages.isActive, true),
          isNotNull(socialPages.encryptedPageAccessToken),
        ),
      ),
    )
    .returning({ id: socialPages.id });

  return { created, updated, deactivated: missing.length, skipped };
}
