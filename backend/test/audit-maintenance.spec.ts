import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

/**
 * M9-T4 (D4 a): `shield.audit_maintenance` lets a transaction past the audit-log trigger
 * (migration 0046). Only test cleanups may set it; app code under `src/` never mentions it.
 */
describe('audit maintenance setting', () => {
  it('no file under src/ uses audit_maintenance', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' });
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((file) => {
      const path = join(SRC, file);
      return (
        /\.[cm]?[jt]sx?$|\.sql$/.test(file) &&
        readFileSync(path, 'utf8').includes('audit_maintenance')
      );
    });
    expect(offenders).toEqual([]);
  });
});
