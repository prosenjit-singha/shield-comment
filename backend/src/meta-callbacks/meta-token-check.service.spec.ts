import { Logger } from '@nestjs/common';
import type { TokenCipherService } from '../crypto/token-cipher.service.js';
import { TokenDecryptionError } from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import type {
  MetaGraphClient,
  MetaTokenDebugInfo,
} from '../meta/meta-graph.client.js';
import { META_LOGIN_SCOPES } from '../meta/meta-graph.config.js';
import {
  MetaGraphError,
  type MetaGraphErrorKind,
} from '../meta/meta-graph.errors.js';
import type {
  TokenCheckRow,
  TokenCheckUpdate,
} from './meta-callbacks.queries.js';
import { MetaTokenCheckService } from './meta-token-check.service.js';

const queries = vi.hoisted(() => ({
  list: vi.fn<
    (db: unknown, afterId: string | null, limit: number) => Promise<unknown[]>
  >(),
  apply: vi.fn<(db: unknown, update: unknown) => Promise<boolean>>(),
}));
vi.mock('./meta-callbacks.queries.js', () => ({
  listConnectionsForTokenCheck: queries.list,
  applyTokenCheckResult: queries.apply,
}));

const WS = '0195a1b2-0000-7000-8000-0000000000aa';
const EXPIRES = new Date('2027-01-15T00:00:00.000Z');
const NOW = new Date('2026-11-19T21:00:00.000Z');
const ALL = [...META_LOGIN_SCOPES];

const row = (n: number, overrides: Partial<TokenCheckRow> = {}) =>
  ({
    id: `0195a1b2-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`,
    workspaceId: WS,
    facebookUserId: `1000000000000${n}`,
    status: 'ACTIVE',
    encryptedUserAccessToken: `v1:k:${n}`,
    tokenExpiresAt: EXPIRES,
    ...overrides,
  }) satisfies TokenCheckRow;

const valid = (scopes = ALL, expiresAt: Date | null = EXPIRES) =>
  ({ isValid: true, scopes, expiresAt }) satisfies MetaTokenDebugInfo;
const graphError = (kind: MetaGraphErrorKind) =>
  new MetaGraphError(kind, `Meta Graph: ${kind}`);

describe('MetaTokenCheckService', () => {
  const debugToken = vi.fn<MetaGraphClient['debugToken']>();
  const decrypt = vi.fn<TokenCipherService['decrypt']>();
  const graph = { enabled: true, debugToken };
  const cipher = { isConfigured: true, decrypt };
  const service = new MetaTokenCheckService(
    {} as Database,
    graph as unknown as MetaGraphClient,
    cipher as unknown as TokenCipherService,
  );
  let logs: string[];

  /** Serves `rows` in pages like the keyset query. */
  function serve(rows: TokenCheckRow[]) {
    queries.list.mockImplementation((_db, afterId, limit) => {
      const start =
        afterId === null ? 0 : rows.findIndex((r) => r.id === afterId) + 1;
      return Promise.resolve(rows.slice(start, start + limit));
    });
  }
  const updates = () =>
    queries.apply.mock.calls.map(([, update]) => update as TokenCheckUpdate);

  beforeEach(() => {
    queries.list.mockReset();
    queries.apply.mockReset().mockResolvedValue(true);
    debugToken.mockReset();
    decrypt.mockReset().mockImplementation((stored) => `plain-${stored}`);
    graph.enabled = true;
    cipher.isConfigured = true;
    service.pauseMs = 0;
    service.pageSize = 100;
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message) => {
        logs.push(`${level}: ${String(message)}`);
      });
    }
  });
  afterEach(() => {
    // Never a token in the logs.
    expect(logs.join('\n')).not.toMatch(/plain-|v1:k:/);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    [
      'meta_not_configured',
      (): void => {
        graph.enabled = false;
      },
    ],
    [
      'cipher_not_configured',
      (): void => {
        cipher.isConfigured = false;
      },
    ],
  ] as const)('skips with one warning when %s', async (reason, setUp) => {
    setUp();
    expect(await service.run()).toEqual({
      kind: 'token_check_skipped',
      reason,
    });
    expect(queries.list).not.toHaveBeenCalled();
    expect(debugToken).not.toHaveBeenCalled();
    expect(logs.filter((l) => l.startsWith('warn'))).toHaveLength(1);
  });

  it('decrypts with the row context and maps each verdict; writes only changes', async () => {
    serve([
      row(1), // valid, same expiry → unchanged
      row(2, { status: 'NEEDS_REAUTH' }), // fixed token → ACTIVE
      row(3), // scope missing → NEEDS_REAUTH
      row(4), // is_valid false → NEEDS_REAUTH
      row(5, { status: 'NEEDS_REAUTH' }), // still invalid → unchanged
      row(6), // new expiry → refreshed, status kept
    ]);
    debugToken
      .mockResolvedValueOnce(valid())
      .mockResolvedValueOnce(valid())
      .mockResolvedValueOnce(valid(ALL.slice(1)))
      .mockResolvedValueOnce({ isValid: false, scopes: [], expiresAt: null })
      .mockResolvedValueOnce({ isValid: false, scopes: [], expiresAt: null })
      .mockResolvedValueOnce(valid(ALL, new Date('2027-02-01T00:00:00Z')));

    const outcome = await service.run(() => NOW);

    expect(decrypt).toHaveBeenCalledWith(
      'v1:k:1',
      `meta_user_token:${WS}:10000000000001`,
    );
    expect(debugToken).toHaveBeenNthCalledWith(1, 'plain-v1:k:1');
    expect(outcome).toEqual({
      kind: 'token_check',
      rateLimited: false,
      counts: {
        checked: 6,
        unchanged: 2,
        toActive: 1,
        toNeedsReauth: 2,
        expiryRefreshed: 1,
        raced: 0,
        graphErrors: 0,
        undecryptable: 0,
        notChecked: 0,
      },
    });
    expect(updates()).toEqual([
      {
        workspaceId: WS,
        connectionId: row(2).id,
        observedStatus: 'NEEDS_REAUTH',
        observedToken: 'v1:k:2',
        status: 'ACTIVE',
        tokenExpiresAt: EXPIRES,
        now: NOW,
      },
      expect.objectContaining({
        connectionId: row(3).id,
        status: 'NEEDS_REAUTH',
        tokenExpiresAt: EXPIRES,
      }),
      expect.objectContaining({
        connectionId: row(4).id,
        observedStatus: 'ACTIVE',
        status: 'NEEDS_REAUTH',
        tokenExpiresAt: undefined,
      }),
      expect.objectContaining({
        connectionId: row(6).id,
        status: 'ACTIVE',
        observedStatus: 'ACTIVE',
        tokenExpiresAt: new Date('2027-02-01T00:00:00Z'),
      }),
    ]);
    const text = logs.join('\n');
    expect(text).toContain(
      `Connection ${row(2).id} (workspace ${WS}): NEEDS_REAUTH → ACTIVE (valid)`,
    );
    expect(text).toContain(`ACTIVE → NEEDS_REAUTH (missing_scope: ${ALL[0]})`);
    expect(text).toContain('ACTIVE → NEEDS_REAUTH (invalid)');
  });

  it('pages through every row by keyset', async () => {
    service.pageSize = 2;
    const rows = [1, 2, 3, 4, 5].map((n) => row(n));
    serve(rows);
    debugToken.mockResolvedValue(valid());
    const outcome = await service.run();
    expect(debugToken).toHaveBeenCalledTimes(5);
    expect(
      queries.list.mock.calls.map(([, afterId, limit]) => [afterId, limit]),
    ).toEqual([
      [null, 2],
      [rows[1]!.id, 2],
      [rows[3]!.id, 2],
    ]);
    expect(outcome).toMatchObject({ counts: { checked: 5, unchanged: 5 } });
  });

  it('pauses between Graph calls (not before the first)', async () => {
    vi.useFakeTimers();
    service.pauseMs = 200;
    serve([row(1), row(2), row(3)]);
    debugToken.mockResolvedValue(valid());
    const done = service.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(debugToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(debugToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(debugToken).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(debugToken).toHaveBeenCalledTimes(3);
  });

  it('transient / network errors leave the row; rate limit stops the run', async () => {
    serve([row(1), row(2), row(3), row(4), row(5)]);
    debugToken
      .mockRejectedValueOnce(graphError('transient'))
      .mockRejectedValueOnce(graphError('network'))
      .mockRejectedValueOnce(graphError('rate_limited'));
    const outcome = await service.run();
    expect(debugToken).toHaveBeenCalledTimes(3);
    expect(queries.apply).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      rateLimited: true,
      counts: { checked: 3, graphErrors: 3, notChecked: 2 },
    });
    expect(logs.join('\n')).toContain('rate limit');
  });

  it('rethrows non-Graph errors (job retried)', async () => {
    serve([row(1)]);
    const boom = new Error('db down');
    debugToken.mockRejectedValue(boom);
    await expect(service.run()).rejects.toBe(boom);
  });

  it('undecryptable token: warn with ids, no Graph call, row left', async () => {
    serve([row(1), row(2)]);
    decrypt.mockImplementationOnce(() => {
      throw new TokenDecryptionError('auth_failed');
    });
    debugToken.mockResolvedValue(valid());
    const outcome = await service.run();
    expect(debugToken).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      counts: { undecryptable: 1, checked: 1, unchanged: 1 },
    });
    expect(logs.join('\n')).toContain(
      `warn: Connection ${row(1).id} (workspace ${WS}): user token cannot be decrypted`,
    );
  });

  it('a row changed meanwhile (Deauthorize / re-connect) counts as raced', async () => {
    serve([row(1)]);
    debugToken.mockResolvedValue({
      isValid: false,
      scopes: [],
      expiresAt: null,
    });
    queries.apply.mockResolvedValue(false);
    const outcome = await service.run();
    expect(outcome).toMatchObject({
      counts: { raced: 1, toNeedsReauth: 0 },
    });
    expect(logs.join('\n')).not.toContain('→ NEEDS_REAUTH');
  });

  it('Graph token_invalid → NEEDS_REAUTH once another call proved the app token', async () => {
    serve([row(1), row(2)]);
    debugToken
      .mockRejectedValueOnce(graphError('token_invalid'))
      .mockResolvedValueOnce(valid());
    const outcome = await service.run();
    expect(updates()).toEqual([
      expect.objectContaining({
        connectionId: row(1).id,
        status: 'NEEDS_REAUTH',
      }),
    ]);
    expect(outcome).toMatchObject({
      counts: { toNeedsReauth: 1, unchanged: 1, graphErrors: 0 },
    });
    expect(logs.join('\n')).toContain('(graph_token_invalid)');
  });

  it('Graph token_invalid on every call → app token suspect, nothing written', async () => {
    serve([row(1), row(2)]);
    debugToken.mockRejectedValue(graphError('token_invalid'));
    const outcome = await service.run();
    expect(queries.apply).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      counts: { checked: 2, graphErrors: 2, toNeedsReauth: 0 },
    });
    expect(logs.join('\n')).toContain('app access token may be rejected');
  });

  it('no rows → empty counts', async () => {
    serve([]);
    expect(await service.run()).toMatchObject({
      kind: 'token_check',
      counts: { checked: 0 },
    });
  });
});
