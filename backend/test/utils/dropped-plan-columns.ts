import { type SQL, sql } from 'drizzle-orm';

type Executor = { execute: (query: SQL) => PromiseLike<{ rows: unknown[] }> };

/**
 * Migration 0029 (PR-T7) dropped the old offer + trial plan columns that earlier data migrations
 * (0008, 0022, 0027) read or write. A replay adds them back with their applied seed values inside
 * its rolled-back transaction.
 */
export async function addDroppedPlanColumns(tx: Executor): Promise<void> {
  await tx.execute(sql`
    alter table plans add column offer_price_bdt integer, add column offer_badge text,
      add column trial_days integer, add column trial_comment_limit integer`);
  await tx.execute(sql`
    update plans p set offer_price_bdt = v.offer, offer_badge = v.badge,
      trial_days = v.days, trial_comment_limit = v.comments
    from (values ('starter', 499, '50% Launch Offer', 7, 300),
      ('growth', 1499, '40% Off', null, null),
      ('pro', 3999, '33% Off', null, null))
      as v (slug, offer, badge, days, comments)
    where p.slug = v.slug`);
}

/** The re-added columns per plan in sort order: `[slug, offer, badge, trialDays, trialComments]`. */
export async function droppedPlanColumns(tx: Executor): Promise<unknown[][]> {
  const { rows } = await tx.execute(sql`
    select slug, offer_price_bdt, offer_badge, trial_days, trial_comment_limit
    from plans order by sort_order, slug`);
  return (rows as Record<string, unknown>[]).map((r) => Object.values(r));
}
