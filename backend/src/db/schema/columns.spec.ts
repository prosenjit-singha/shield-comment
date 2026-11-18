import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns.js';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sample = pgTable('sample_rows', {
  id: id(),
  displayName: text().notNull(),
  ...timestamps,
});

describe('schema column conventions', () => {
  it('ids are uuid primary keys with an app-generated UUIDv7 default', () => {
    const { id: col } = getTableColumns(sample);
    expect(col.getSQLType()).toBe('uuid');
    expect(col.primary).toBe(true);
    const a = col.defaultFn!() as string;
    const b = col.defaultFn!() as string;
    expect(a).toMatch(UUID_V7);
    expect(b > a).toBe(true); // time-ordered
  });

  it('timestamps are timestamptz(3), not null, with updatedAt refreshed on update', () => {
    const { createdAt, updatedAt } = getTableColumns(sample);
    for (const col of [createdAt, updatedAt]) {
      expect(col.getSQLType()).toBe('timestamp (3) with time zone');
      expect(col.notNull).toBe(true);
    }
    expect(updatedAt.onUpdateFn?.()).toBeInstanceOf(Date);
  });

  it('camelCase keys become snake_case SQL with casing: snake_case', () => {
    const db = drizzle.mock({ casing: 'snake_case' });
    const { sql } = db
      .insert(sample)
      .values({ displayName: 'x' })
      .returning({ id: sample.id })
      .toSQL();
    expect(sql).toMatch(
      /^insert into "sample_rows" \("id", "display_name", "created_at", "updated_at"\)/,
    );
  });
});
