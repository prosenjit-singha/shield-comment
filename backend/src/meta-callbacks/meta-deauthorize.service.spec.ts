import type { Database } from '../db/database.js';
import * as queries from './meta-callbacks.queries.js';
import { MetaDeauthorizeService } from './meta-deauthorize.service.js';

vi.mock('./meta-callbacks.queries.js', () => ({
  findConnectionsByFacebookUser: vi.fn(),
  lockWorkspace: vi.fn(),
  lockConnection: vi.fn(),
  revokeConnection: vi.fn(),
  deactivateWorkspacePages: vi.fn(),
}));

const q = vi.mocked(queries);
const tx = { tx: true };
const transaction = vi.fn((fn: (t: unknown) => unknown) => fn(tx));
const db = { transaction } as unknown as Database;
const NOW = new Date('2026-11-18T12:00:00Z');
const FB = '10000000000001';

describe('MetaDeauthorizeService', () => {
  const service = new MetaDeauthorizeService(db);

  beforeEach(() => {
    vi.clearAllMocks();
    q.findConnectionsByFacebookUser.mockResolvedValue([
      { id: 'c-a', workspaceId: 'ws-a' },
      { id: 'c-b', workspaceId: 'ws-b' },
    ]);
    q.lockWorkspace.mockResolvedValue(true);
    q.lockConnection.mockImplementation((_tx, workspaceId) =>
      Promise.resolve({ id: `c-${workspaceId.slice(3)}`, workspaceId }),
    );
    q.revokeConnection.mockResolvedValue(true);
    q.deactivateWorkspacePages.mockResolvedValue(2);
  });

  it('revokes every connection of the user and switches their Pages off, in one tx', async () => {
    expect(await service.deauthorize(FB, NOW)).toEqual({
      connections: 2,
      revoked: 2,
      pages: 4,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(q.findConnectionsByFacebookUser).toHaveBeenCalledWith(tx, FB);
    for (const ws of ['ws-a', 'ws-b']) {
      expect(q.lockWorkspace).toHaveBeenCalledWith(tx, ws);
      expect(q.lockConnection).toHaveBeenCalledWith(tx, ws, FB);
      expect(q.revokeConnection).toHaveBeenCalledWith(
        tx,
        ws,
        `c-${ws.slice(3)}`,
        NOW,
      );
      expect(q.deactivateWorkspacePages).toHaveBeenCalledWith(tx, ws, NOW);
    }
  });

  it('locks workspace → connection before writing (order per workspace)', async () => {
    await service.deauthorize(FB, NOW);
    const order = [
      q.lockWorkspace.mock.invocationCallOrder[0]!,
      q.lockConnection.mock.invocationCallOrder[0]!,
      q.revokeConnection.mock.invocationCallOrder[0]!,
      q.deactivateWorkspacePages.mock.invocationCallOrder[0]!,
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it('a repeat changes nothing (revoked 0, pages 0) and still succeeds', async () => {
    q.revokeConnection.mockResolvedValue(false);
    q.deactivateWorkspacePages.mockResolvedValue(0);
    expect(await service.deauthorize(FB, NOW)).toEqual({
      connections: 2,
      revoked: 0,
      pages: 0,
    });
  });

  it('unknown user → nothing to do', async () => {
    q.findConnectionsByFacebookUser.mockResolvedValue([]);
    expect(await service.deauthorize(FB, NOW)).toEqual({
      connections: 0,
      revoked: 0,
      pages: 0,
    });
    expect(q.lockWorkspace).not.toHaveBeenCalled();
  });

  it('skips a workspace that is gone or a connection re-connected by someone else', async () => {
    q.lockWorkspace.mockImplementation((_tx, ws) =>
      Promise.resolve(ws !== 'ws-a'),
    );
    q.lockConnection.mockResolvedValue(undefined);
    expect(await service.deauthorize(FB, NOW)).toEqual({
      connections: 0,
      revoked: 0,
      pages: 0,
    });
    expect(q.lockConnection).toHaveBeenCalledTimes(1);
    expect(q.revokeConnection).not.toHaveBeenCalled();
    expect(q.deactivateWorkspacePages).not.toHaveBeenCalled();
  });

  it('propagates DB errors (the tx rolls back)', async () => {
    q.revokeConnection.mockRejectedValue(new Error('db down'));
    await expect(service.deauthorize(FB, NOW)).rejects.toThrow('db down');
  });
});
