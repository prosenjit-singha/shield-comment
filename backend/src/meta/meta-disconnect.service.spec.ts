import { ForbiddenException, Logger } from '@nestjs/common';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import type { TokenCipherService } from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import * as queries from './meta-disconnect.queries.js';
import type {
  DisconnectConnectionRow,
  DisconnectPageRow,
} from './meta-disconnect.queries.js';
import { MetaDisconnectService } from './meta-disconnect.service.js';
import type { MetaGraphClient } from './meta-graph.client.js';
import { MetaGraphError } from './meta-graph.errors.js';
import * as pageQueries from './social-pages.queries.js';

vi.mock('./meta-disconnect.queries.js', () => ({
  findDisconnectConnection: vi.fn(),
  findDisconnectPages: vi.fn(),
  keepPageComments: vi.fn(),
  deleteWorkspacePages: vi.fn(),
  deleteWorkspaceConnection: vi.fn(),
  facebookUserStillConnected: vi.fn(),
}));

vi.mock('./social-pages.queries.js', () => ({
  findWorkspacePlanId: vi.fn(),
}));

const q = vi.mocked(queries);
const pq = vi.mocked(pageQueries);

const WS = '019a0000-0000-7000-8000-000000000001';
const FB = '5550001';
const CONN: DisconnectConnectionRow = {
  id: '019a0000-0000-7000-8000-0000000000c1',
  facebookUserId: FB,
  encryptedUserAccessToken: 'v1:k:user',
};
const PAGES: DisconnectPageRow[] = [
  {
    id: '019a0000-0000-7000-8000-0000000000a1',
    pageId: '1001',
    encryptedPageAccessToken: 'v1:k:p1',
  },
  {
    id: '019a0000-0000-7000-8000-0000000000a2',
    pageId: '1002',
    encryptedPageAccessToken: 'v1:k:p2',
  },
];
const workspace: WorkspaceContext = { id: WS, role: 'owner' };
const session = (impersonatedBy: string | null = null) =>
  ({
    user: { id: 'u1' },
    session: { impersonatedBy, activeOrganizationId: WS },
  }) as unknown as AuthSession;

/** Fake cipher: `v1:k:<x>` → `EAA<x>` (context must match), `v1:bad:*` fails. */
function fakeCipher(configured = true) {
  return {
    isConfigured: configured,
    decrypt: vi.fn((ciphertext: string, context: string) => {
      if (ciphertext.startsWith('v1:bad:')) throw new Error('auth tag');
      return `EAA${ciphertext.slice(5)}|${context}`;
    }),
  };
}

const userContext = `meta_user_token:${WS}:${FB}`;
const pageContext = (pageId: string) => `meta_page_token:${WS}:${pageId}`;

function setup(options: { enabled?: boolean; cipher?: boolean } = {}) {
  const tx = { tag: 'tx' };
  const order: string[] = [];
  const db = {
    tag: 'db',
    transaction: vi.fn(async <T>(fn: (t: typeof tx) => Promise<T>) => {
      order.push('tx:start');
      const result = await fn(tx);
      order.push('tx:commit');
      return result;
    }),
  };
  const graph = {
    enabled: options.enabled ?? true,
    unsubscribePageApp: vi.fn<MetaGraphClient['unsubscribePageApp']>(
      async (pageId) => {
        order.push(`unsubscribe:${pageId}`);
      },
    ),
    revokePermissions: vi.fn<MetaGraphClient['revokePermissions']>(async () => {
      order.push('revoke');
    }),
  };
  const cipher = fakeCipher(options.cipher ?? true);
  cipher.decrypt.mockImplementation((ciphertext: string, context: string) => {
    order.push(`decrypt:${ciphertext}`);
    if (ciphertext.startsWith('v1:bad:')) throw new Error('auth tag');
    return `EAA${ciphertext.slice(5)}|${context}`;
  });
  const svc = new MetaDisconnectService(
    db as unknown as Database,
    graph as unknown as MetaGraphClient,
    cipher as unknown as TokenCipherService,
  );
  return { svc, db, tx, graph, cipher, order };
}

function arm(
  options: {
    snapshot?: {
      connection?: DisconnectConnectionRow;
      pages?: DisconnectPageRow[];
    };
    locked?: {
      connection?: DisconnectConnectionRow;
      pages?: DisconnectPageRow[];
    };
    stillConnected?: boolean;
  } = {},
) {
  const snapshot = {
    connection: CONN as DisconnectConnectionRow | undefined,
    pages: PAGES,
    ...options.snapshot,
  };
  const locked = { ...snapshot, ...options.locked };
  pq.findWorkspacePlanId.mockResolvedValue({ planId: null });
  q.findDisconnectConnection.mockImplementation(async (_e, _w, lock) =>
    lock ? locked.connection : snapshot.connection,
  );
  q.findDisconnectPages.mockImplementation(async (_e, _w, lock) =>
    lock ? locked.pages : snapshot.pages,
  );
  q.keepPageComments.mockResolvedValue(7);
  q.deleteWorkspacePages.mockImplementation(async (_t, _w, ids) => ids.length);
  q.deleteWorkspaceConnection.mockResolvedValue(true);
  q.facebookUserStillConnected.mockResolvedValue(
    options.stillConnected ?? false,
  );
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

/** Logged lines never carry a token or ciphertext. */
function expectCleanLogs() {
  for (const args of warn.mock.calls) {
    const line = args.map(String).join(' ');
    expect(line).not.toMatch(/EAA|v1:/);
  }
}

describe('MetaDisconnectService.disconnect', () => {
  it('impersonated → 403 before any read, tx or Graph call', async () => {
    const { svc, db, graph } = setup();
    arm();
    await expect(
      svc.disconnect(session('admin-1'), workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(q.findDisconnectConnection).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
    expect(graph.revokePermissions).not.toHaveBeenCalled();
  });

  it('decrypts before the tx, deletes in one tx (locks → stamp → Pages → connection), Graph only after commit', async () => {
    const { svc, db, tx, graph, order } = setup();
    arm();
    await expect(svc.disconnect(session(), workspace)).resolves.toEqual({
      disconnected: true,
      pagesDeleted: 2,
      commentsKept: 7,
    });
    expect(order).toEqual([
      'decrypt:v1:k:user',
      'decrypt:v1:k:p1',
      'decrypt:v1:k:p2',
      'tx:start',
      'tx:commit',
      'unsubscribe:1001',
      'unsubscribe:1002',
      'revoke',
    ]);
    // Snapshot reads on the db, scoped, without locks.
    expect(q.findDisconnectConnection).toHaveBeenCalledWith(db, WS);
    expect(q.findDisconnectPages).toHaveBeenCalledWith(db, WS);
    // In the tx: workspace lock → connection lock → Pages lock → stamp → delete Pages → connection.
    expect(pq.findWorkspacePlanId).toHaveBeenCalledWith(tx, WS, true);
    expect(q.findDisconnectConnection).toHaveBeenCalledWith(tx, WS, true);
    expect(q.findDisconnectPages).toHaveBeenCalledWith(tx, WS, true);
    const ids = PAGES.map((p) => p.id);
    expect(q.keepPageComments).toHaveBeenCalledWith(tx, WS, ids, FB);
    expect(q.deleteWorkspacePages).toHaveBeenCalledWith(tx, WS, ids);
    expect(q.deleteWorkspaceConnection).toHaveBeenCalledWith(tx, WS, CONN.id);
    expect(q.facebookUserStillConnected).toHaveBeenCalledWith(tx, FB);
    const seq = [
      pq.findWorkspacePlanId.mock.invocationCallOrder[0]!,
      q.findDisconnectConnection.mock.invocationCallOrder[1]!,
      q.findDisconnectPages.mock.invocationCallOrder[1]!,
      q.keepPageComments.mock.invocationCallOrder[0]!,
      q.deleteWorkspacePages.mock.invocationCallOrder[0]!,
      q.deleteWorkspaceConnection.mock.invocationCallOrder[0]!,
      q.facebookUserStillConnected.mock.invocationCallOrder[0]!,
    ];
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    // Graph gets the decrypted tokens (right AAD context per row).
    expect(graph.unsubscribePageApp).toHaveBeenNthCalledWith(
      1,
      '1001',
      `EAAp1|${pageContext('1001')}`,
    );
    expect(graph.unsubscribePageApp).toHaveBeenNthCalledWith(
      2,
      '1002',
      `EAAp2|${pageContext('1002')}`,
    );
    expect(graph.revokePermissions).toHaveBeenCalledWith(
      `EAAuser|${userContext}`,
    );
  });

  it('Graph failures are logged (ids + kind) and never change the response', async () => {
    const { svc, graph } = setup();
    arm();
    graph.unsubscribePageApp.mockRejectedValueOnce(
      new MetaGraphError('token_invalid', 'Meta Graph 400 (#190)', {
        status: 400,
        code: 190,
      }),
    );
    graph.unsubscribePageApp.mockRejectedValueOnce(new Error('boom'));
    graph.revokePermissions.mockRejectedValue(
      new MetaGraphError('transient', 'Meta Graph 500', { status: 500 }),
    );
    await expect(svc.disconnect(session(), workspace)).resolves.toEqual({
      disconnected: true,
      pagesDeleted: 2,
      commentsKept: 7,
    });
    expect(graph.unsubscribePageApp).toHaveBeenCalledTimes(2);
    expect(graph.revokePermissions).toHaveBeenCalledTimes(1);
    const lines = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(lines).toEqual([
      `Page ${PAGES[0]!.id} (workspace ${WS}): unsubscribe on disconnect failed (token_invalid #190)`,
      `Page ${PAGES[1]!.id} (workspace ${WS}): unsubscribe on disconnect failed (Error)`,
      `Workspace ${WS}: Meta permissions revoke on disconnect failed (transient)`,
    ]);
    expectCleanLogs();
  });

  it('undecryptable tokens skip only their Graph call', async () => {
    const { svc, graph } = setup();
    arm({
      snapshot: {
        connection: { ...CONN, encryptedUserAccessToken: 'v1:bad:user' },
        pages: [
          { ...PAGES[0]!, encryptedPageAccessToken: 'v1:bad:p1' },
          PAGES[1]!,
        ],
      },
    });
    await expect(svc.disconnect(session(), workspace)).resolves.toMatchObject({
      disconnected: true,
      pagesDeleted: 2,
    });
    expect(graph.unsubscribePageApp).toHaveBeenCalledTimes(1);
    expect(graph.unsubscribePageApp).toHaveBeenCalledWith(
      '1002',
      expect.any(String),
    );
    expect(graph.revokePermissions).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      `Page ${PAGES[0]!.id} (workspace ${WS}): Page token cannot be decrypted; unsubscribe skipped`,
    );
    expectCleanLogs();
  });

  it('a token replaced between the read and the lock (re-connect) is not used', async () => {
    const { svc, graph } = setup();
    arm({
      locked: {
        connection: { ...CONN, encryptedUserAccessToken: 'v1:k:newuser' },
        pages: [
          { ...PAGES[0]!, encryptedPageAccessToken: 'v1:k:newp1' },
          PAGES[1]!,
        ],
      },
    });
    await svc.disconnect(session(), workspace);
    expect(graph.unsubscribePageApp).toHaveBeenCalledTimes(1);
    expect(graph.unsubscribePageApp).toHaveBeenCalledWith(
      '1002',
      expect.any(String),
    );
    expect(graph.revokePermissions).not.toHaveBeenCalled();
  });

  it('a Page added between the read and the lock is deleted without a Graph call', async () => {
    const { svc, graph } = setup();
    const added: DisconnectPageRow = {
      id: '019a0000-0000-7000-8000-0000000000a3',
      pageId: '1003',
      encryptedPageAccessToken: 'v1:k:p3',
    };
    arm({ locked: { pages: [...PAGES, added] } });
    await expect(svc.disconnect(session(), workspace)).resolves.toMatchObject({
      pagesDeleted: 3,
    });
    expect(graph.unsubscribePageApp).toHaveBeenCalledTimes(2);
    expect(graph.unsubscribePageApp).not.toHaveBeenCalledWith(
      '1003',
      expect.anything(),
    );
  });

  it('the Facebook user still has another workspace connected → permissions kept', async () => {
    const { svc, graph } = setup();
    arm({ stillConnected: true });
    await svc.disconnect(session(), workspace);
    expect(graph.unsubscribePageApp).toHaveBeenCalledTimes(2);
    expect(graph.revokePermissions).not.toHaveBeenCalled();
  });

  it.each([
    ['Meta unset', { enabled: false }],
    ['cipher unset', { cipher: false }],
  ])('%s → rows still deleted, no decrypt, no Graph call', async (_l, opts) => {
    const { svc, graph, cipher } = setup(opts);
    arm();
    await expect(svc.disconnect(session(), workspace)).resolves.toEqual({
      disconnected: true,
      pagesDeleted: 2,
      commentsKept: 7,
    });
    expect(cipher.decrypt).not.toHaveBeenCalled();
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
    expect(graph.revokePermissions).not.toHaveBeenCalled();
  });

  it('REVOKED connection (tokens cleared by Deauthorize) → deleted, nothing to call', async () => {
    const { svc, graph } = setup();
    arm({
      snapshot: {
        connection: { ...CONN, encryptedUserAccessToken: null },
        pages: PAGES.map((p) => ({ ...p, encryptedPageAccessToken: null })),
      },
    });
    await expect(svc.disconnect(session(), workspace)).resolves.toMatchObject({
      disconnected: true,
      pagesDeleted: 2,
    });
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
    expect(graph.revokePermissions).not.toHaveBeenCalled();
  });

  it('Pages without a connection row → Pages deleted, comments only counted (no stamp)', async () => {
    const { svc, tx, graph } = setup();
    arm({ snapshot: { connection: undefined } });
    q.keepPageComments.mockResolvedValue(3);
    await expect(svc.disconnect(session(), workspace)).resolves.toEqual({
      disconnected: true,
      pagesDeleted: 2,
      commentsKept: 3,
    });
    expect(q.keepPageComments).toHaveBeenCalledWith(
      tx,
      WS,
      PAGES.map((p) => p.id),
      null,
    );
    expect(q.deleteWorkspaceConnection).not.toHaveBeenCalled();
    expect(graph.unsubscribePageApp).toHaveBeenCalledTimes(2);
    expect(graph.revokePermissions).not.toHaveBeenCalled();
  });

  it('nothing to delete → idempotent { disconnected: false }, no Graph call', async () => {
    const { svc, graph } = setup();
    arm({ snapshot: { connection: undefined, pages: [] } });
    q.keepPageComments.mockResolvedValue(0);
    await expect(svc.disconnect(session(), workspace)).resolves.toEqual({
      disconnected: false,
      pagesDeleted: 0,
      commentsKept: 0,
    });
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
    expect(graph.revokePermissions).not.toHaveBeenCalled();
  });

  it('workspace row gone under the lock → nothing deleted', async () => {
    const { svc, graph } = setup();
    arm();
    pq.findWorkspacePlanId.mockResolvedValue(undefined);
    await expect(svc.disconnect(session(), workspace)).resolves.toEqual({
      disconnected: false,
      pagesDeleted: 0,
      commentsKept: 0,
    });
    expect(q.deleteWorkspacePages).not.toHaveBeenCalled();
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
  });

  it('a DB error in the tx propagates and no Graph call is made', async () => {
    const { svc, graph } = setup();
    arm();
    q.deleteWorkspacePages.mockRejectedValue(new Error('connection lost'));
    await expect(svc.disconnect(session(), workspace)).rejects.toThrow(
      'connection lost',
    );
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
    expect(graph.revokePermissions).not.toHaveBeenCalled();
  });
});
