import { drizzle } from 'drizzle-orm/node-postgres';
import type { Database } from '../db/database.js';
import { planTiersQuery } from './admin-dashboard.service.js';

const db = drizzle.mock({ casing: 'snake_case' }) as unknown as Database;

describe('planTiersQuery (PW-T6b)', () => {
  const NOW = new Date('2026-11-20T06:00:00.000Z');

  it('counts ACTIVE workspaces per live-subscription plan, not workspaces.plan_id', () => {
    const { sql, params } = planTiersQuery(db, NOW).toSQL();
    expect(sql).toBe(
      'select "plans"."name", "plans"."sort_order", count(*) from "workspaces" ' +
        'inner join "subscriptions" on ("subscriptions"."billing_account_id" = "workspaces"."billing_account_id" ' +
        'and ("subscriptions"."status" in ($1, $2) and ("subscriptions"."current_term_end" > $3 or ("subscriptions"."scheduled_plan_id" is not null and "subscriptions"."current_term_end" + interval \'28 days\' > $4)))) ' +
        'inner join "plans" on "plans"."id" = "subscriptions"."plan_id" ' +
        'where "workspaces"."status" = $5 group by "plans"."id" ' +
        'order by "plans"."sort_order" asc, "plans"."name" asc',
    );
    expect(params).toEqual([
      'TRIALING',
      'ACTIVE',
      NOW.toISOString(),
      NOW,
      'ACTIVE',
    ]);
    expect(sql).not.toContain('."plan_id" is');
    expect(sql).not.toContain('"workspaces"."plan_id"');
  });
});
