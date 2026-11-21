import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '../db/database.js';
import { workspaces } from '../db/schema/index.js';
import {
  clientListOrder,
  clientListWhere,
  createdRange,
  escapeLike,
} from './client-list-query.js';

const db = drizzle.mock({ casing: 'snake_case' }) as unknown as Database;

function whereSql(filters: Parameters<typeof clientListWhere>[1]) {
  return db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(clientListWhere(db, filters))
    .toSQL();
}

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
    expect(escapeLike('রহিম shop')).toBe('রহিম shop');
  });
});

describe('createdRange', () => {
  it('turns inclusive bounds into [from, before)', () => {
    expect(createdRange()).toEqual({ from: undefined, before: undefined });
    expect(createdRange('2026-11-01', '2026-11-18')).toEqual({
      from: new Date('2026-11-01T00:00:00.000Z'),
      before: new Date('2026-11-19T00:00:00.000Z'),
    });
    expect(
      createdRange(
        '2026-11-18T00:00:00+06:00',
        '2026-11-18T23:59:59.999+06:00',
      ),
    ).toEqual({
      from: new Date('2026-11-17T18:00:00.000Z'),
      before: new Date('2026-11-18T18:00:00.000Z'),
    });
  });
});

describe('clientListWhere', () => {
  it('has no WHERE without filters', () => {
    expect(clientListWhere(db, {})).toBeUndefined();
    expect(whereSql({}).sql).not.toContain('where');
  });

  it('q matches name, slug, or an owner email/name, case-insensitively and escaped', () => {
    const { sql, params } = whereSql({ q: '50%' });
    expect(sql).toContain(
      '("workspaces"."name" ilike $1 or "workspaces"."slug" ilike $2 or exists (select 1 from "workspace_members" inner join "users" on "users"."id" = "workspace_members"."user_id" where ("workspace_members"."workspace_id" = "workspaces"."id" and "workspace_members"."role" = $3 and ("users"."email" ilike $4 or "users"."name" ilike $5))))',
    );
    expect(params).toEqual([
      '%50\\%%',
      '%50\\%%',
      'owner',
      '%50\\%%',
      '%50\\%%',
    ]);
  });

  it('combines status and the created-at range with AND', () => {
    const { sql, params } = whereSql({
      status: 'SUSPENDED',
      createdFrom: '2026-11-01',
      createdTo: '2026-11-18',
    });
    expect(sql).toContain(
      'where ("workspaces"."status" = $1 and "workspaces"."created_at" >= $2 and "workspaces"."created_at" < $3)',
    );
    expect(params).toEqual([
      'SUSPENDED',
      '2026-11-01T00:00:00.000Z',
      '2026-11-19T00:00:00.000Z',
    ]);
  });
});

describe('clientListWhere plan filter (live subscription, PW-T6b)', () => {
  const PLAN = '019a0000-0000-7000-8000-0000000000b1';
  const NOW = new Date('2026-11-20T06:00:00.000Z');
  const where = (filters: Parameters<typeof clientListWhere>[1]) =>
    db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(clientListWhere(db, filters, NOW))
      .toSQL();
  const live =
    'select 1 from "subscriptions" where ("subscriptions"."billing_account_id" = "workspaces"."billing_account_id" and ("subscriptions"."status" in ($1, $2) and ("subscriptions"."current_term_end" > $3 or ("subscriptions"."scheduled_plan_id" is not null and "subscriptions"."current_term_end" + interval \'28 days\' > $4)))';

  it('an id = the account has a live subscription on that plan', () => {
    const { sql, params } = where({ planId: PLAN, status: 'ACTIVE' });
    expect(sql).toContain(
      'where ("workspaces"."status" = $1 and exists (select 1 from "subscriptions" where ("subscriptions"."billing_account_id" = "workspaces"."billing_account_id" and ("subscriptions"."status" in ($2, $3) and ("subscriptions"."current_term_end" > $4 or ("subscriptions"."scheduled_plan_id" is not null and "subscriptions"."current_term_end" + interval \'28 days\' > $5))) and "subscriptions"."plan_id" = $6)))',
    );
    expect(params).toEqual([
      'ACTIVE',
      'TRIALING',
      'ACTIVE',
      NOW.toISOString(),
      NOW,
      PLAN,
    ]);
    expect(sql).not.toContain('plan_id" is null');
  });

  it('null (`none`) = no live subscription: no account, ended or never', () => {
    const { sql, params } = where({ planId: null });
    expect(sql).toContain(`where not exists (${live}))`);
    expect(params).toEqual(['TRIALING', 'ACTIVE', NOW.toISOString(), NOW]);
  });

  it('undefined = any plan (no condition)', () => {
    expect(clientListWhere(db, { planId: undefined }, NOW)).toBeUndefined();
  });
});

describe('clientListOrder', () => {
  const dialect = new PgDialect({ casing: 'snake_case' });
  const order = (sort: Parameters<typeof clientListOrder>[0]) =>
    clientListOrder(sort).map((part) => dialect.sqlToQuery(part).sql);

  it('sorts newest first, oldest first, or by name A–Z (case-insensitive), with an id tiebreaker', () => {
    expect(order('newest')).toEqual([
      '"workspaces"."created_at" desc',
      '"workspaces"."id" desc',
    ]);
    expect(order('oldest')).toEqual([
      '"workspaces"."created_at" asc',
      '"workspaces"."id" asc',
    ]);
    expect(order('name')).toEqual([
      'lower("workspaces"."name") asc',
      '"workspaces"."id" asc',
    ]);
  });
});
