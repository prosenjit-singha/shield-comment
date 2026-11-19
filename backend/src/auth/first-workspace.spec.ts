import type { Database } from '../db/database.js';
import { workspaceMembers, workspaces } from '../db/schema/index.js';
import {
  firstWorkspaceName,
  parseWorkspaceName,
  resolveActiveWorkspace,
  type SessionBilling,
  slugify,
} from './first-workspace.js';

describe('first workspace helpers', () => {
  it('slugify: ASCII, max 40 chars + random 6-hex suffix', () => {
    expect(slugify("Rahim's Shop!")).toMatch(/^rahim-s-shop-[0-9a-f]{6}$/);
    expect(slugify('ঢাকা ফ্যাশন')).toMatch(/^workspace-[0-9a-f]{6}$/);
    expect(slugify('a'.repeat(100)).length).toBe(47);
    expect(slugify('Shop')).not.toBe(slugify('Shop'));
  });

  it('parseWorkspaceName: undefined when absent, null when invalid, trimmed otherwise', () => {
    expect(parseWorkspaceName({ name: 'x' })).toBeUndefined();
    expect(parseWorkspaceName(undefined)).toBeUndefined();
    expect(parseWorkspaceName({ workspaceName: '  Dhaka Fashion ' })).toBe(
      'Dhaka Fashion',
    );
    expect(parseWorkspaceName({ workspaceName: '   ' })).toBeNull();
    expect(parseWorkspaceName({ workspaceName: 'x'.repeat(81) })).toBeNull();
    expect(parseWorkspaceName({ workspaceName: 42 })).toBeNull();
  });

  it('firstWorkspaceName: workspaceName, else "<name>\'s workspace"', () => {
    expect(firstWorkspaceName({ name: 'Rahim', workspaceName: 'Shop' })).toBe(
      'Shop',
    );
    expect(firstWorkspaceName({ name: ' Rahim ' })).toBe("Rahim's workspace");
    expect(firstWorkspaceName({})).toBe('My workspace');
    expect(firstWorkspaceName({ name: 'n'.repeat(100) })).toHaveLength(80);
  });
});

/**
 * `resolveActiveWorkspace` with a fake Drizzle (only the calls it makes): the oldest membership
 * lookup, and the sign-up transaction (workspace + owner membership + billing, PW-T3).
 */
describe('resolveActiveWorkspace (PW-T3 billing)', () => {
  const USER = 'user-1';
  const linkWorkspace = vi.fn<SessionBilling['linkWorkspace']>();
  const isSetUp = vi.fn<SessionBilling['isSetUp']>();
  const billing: SessionBilling = { linkWorkspace, isSetUp };
  let inserts: { table: unknown; values: unknown }[];
  let tx: object;

  function fakeDb(membership?: { workspaceId: string; role: string }) {
    const select = () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(membership ? [membership] : []),
          }),
        }),
      }),
    });
    const insert = (table: unknown) => ({
      values: (values: unknown) => {
        inserts.push({ table, values });
        const done = Promise.resolve(undefined);
        return Object.assign(done, {
          returning: () => Promise.resolve([{ id: 'ws-new' }]),
        });
      },
    });
    tx = { insert };
    const transaction = async <T>(work: (t: object) => Promise<T>) => work(tx);
    return { select, transaction } as unknown as Database;
  }

  beforeEach(() => {
    linkWorkspace.mockReset().mockResolvedValue('acc-1');
    isSetUp.mockReset();
    inserts = [];
  });

  it('sign-up: workspace + owner membership + billing link in the same transaction (no plan, PR-T3)', async () => {
    const id = await resolveActiveWorkspace(fakeDb(), billing, USER, 'Shop');
    expect(id).toBe('ws-new');
    expect(inserts.map((i) => i.table)).toEqual([workspaces, workspaceMembers]);
    expect(inserts[1]?.values).toEqual({
      workspaceId: 'ws-new',
      userId: USER,
      role: 'owner',
    });
    expect(linkWorkspace).toHaveBeenCalledTimes(1);
    expect(linkWorkspace).toHaveBeenCalledWith(USER, 'ws-new', tx);
    expect(isSetUp).not.toHaveBeenCalled();
  });

  it('a billing failure fails the whole sign-up transaction', async () => {
    linkWorkspace.mockRejectedValueOnce(new Error('db down'));
    await expect(
      resolveActiveWorkspace(fakeDb(), billing, USER, 'Shop'),
    ).rejects.toThrow('db down');
  });

  it('no membership and no sign-up: null, no billing', async () => {
    expect(await resolveActiveWorkspace(fakeDb(), billing, USER)).toBeNull();
    expect(linkWorkspace).not.toHaveBeenCalled();
    expect(isSetUp).not.toHaveBeenCalled();
  });

  it('owner already set up: one check, nothing written', async () => {
    isSetUp.mockResolvedValue(true);
    const db = fakeDb({ workspaceId: 'ws-1', role: 'owner' });
    expect(await resolveActiveWorkspace(db, billing, USER)).toBe('ws-1');
    expect(isSetUp).toHaveBeenCalledWith('ws-1');
    expect(linkWorkspace).not.toHaveBeenCalled();
  });

  it('owner whose workspace has no account: linked on the next session create', async () => {
    isSetUp.mockResolvedValue(false);
    const db = fakeDb({ workspaceId: 'ws-1', role: 'owner' });
    expect(await resolveActiveWorkspace(db, billing, USER, 'Ignored')).toBe(
      'ws-1',
    );
    expect(linkWorkspace).toHaveBeenCalledWith(USER, 'ws-1');
    expect(inserts).toEqual([]);
  });

  it('a non-owner membership is never set up (the payer is the owner)', async () => {
    const db = fakeDb({ workspaceId: 'ws-1', role: 'moderator' });
    expect(await resolveActiveWorkspace(db, billing, USER)).toBe('ws-1');
    expect(isSetUp).not.toHaveBeenCalled();
    expect(linkWorkspace).not.toHaveBeenCalled();
  });
});
