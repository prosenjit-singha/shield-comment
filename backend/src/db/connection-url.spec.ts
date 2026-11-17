import { migrationDatabaseUrl } from './connection-url.js';

describe('migrationDatabaseUrl', () => {
  const pooled = 'postgresql://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/db';
  const direct = 'postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/db';

  it('prefers DIRECT_URL over the pooled DATABASE_URL', () => {
    expect(
      migrationDatabaseUrl({ DATABASE_URL: pooled, DIRECT_URL: direct }),
    ).toBe(direct);
  });

  it('falls back to DATABASE_URL when DIRECT_URL is unset or blank', () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: pooled })).toBe(pooled);
    expect(
      migrationDatabaseUrl({ DATABASE_URL: pooled, DIRECT_URL: '  ' }),
    ).toBe(pooled);
  });

  it('returns undefined when neither is set', () => {
    expect(migrationDatabaseUrl({})).toBeUndefined();
  });
});
