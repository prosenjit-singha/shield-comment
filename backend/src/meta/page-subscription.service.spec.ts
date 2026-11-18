import { Logger } from '@nestjs/common';
import {
  TokenCipherService,
  TokenDecryptionError,
  tokenCipherContext,
} from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import type { MetaGraphClient } from './meta-graph.client.js';
import { MetaGraphError } from './meta-graph.errors.js';
import * as queries from './page-subscription.queries.js';
import {
  PageSubscriptionService,
  type PageWithToken,
} from './page-subscription.service.js';

vi.mock('./page-subscription.queries.js', () => ({
  findWorkspacePageToken: vi.fn(),
  markConnectionNeedsReauth: vi.fn(),
}));

const q = vi.mocked(queries);
const WS = '019a0000-0000-7000-8000-000000000001';
const ROW = '019a0000-0000-7000-8000-0000000000a1';
const PAGE_ID = '1001';
const TOKEN = 'EAApageTokenAbcdefghijklmnopqrstuvwxyz';
const CIPHERTEXT = 'v1:k1:iv:tag:ct';
const NOW = new Date('2026-11-19T00:00:00.000Z');

const page = (patch: Partial<PageWithToken> = {}): PageWithToken => ({
  id: ROW,
  workspaceId: WS,
  pageId: PAGE_ID,
  isActive: false,
  encryptedPageAccessToken: CIPHERTEXT,
  ...patch,
});

function setup(options: { graph?: boolean; cipher?: boolean } = {}) {
  const db = { tag: 'db' };
  const graph = {
    enabled: options.graph ?? true,
    subscribePageApp: vi.fn<MetaGraphClient['subscribePageApp']>(),
    unsubscribePageApp: vi.fn<MetaGraphClient['unsubscribePageApp']>(),
  };
  const cipher = {
    isConfigured: options.cipher ?? true,
    decrypt: vi.fn<TokenCipherService['decrypt']>(() => TOKEN),
  };
  const svc = new PageSubscriptionService(
    db as unknown as Database,
    graph as unknown as MetaGraphClient,
    cipher as unknown as TokenCipherService,
  );
  return { svc, db, graph, cipher };
}

const warnings: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  warnings.length = 0;
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
    warnings.push(String(message));
  });
});
afterEach(() => {
  // Logs carry ids, kinds and codes only.
  for (const line of warnings) {
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(CIPHERTEXT);
  }
});

describe('PageSubscriptionService.configured', () => {
  it('needs both the Meta app and the cipher', () => {
    expect(setup().svc.configured).toBe(true);
    expect(setup({ graph: false }).svc.configured).toBe(false);
    expect(setup({ cipher: false }).svc.configured).toBe(false);
  });
});

describe('PageSubscriptionService.subscribe', () => {
  it('decrypts with the Page context and subscribes with the plaintext token', async () => {
    const { svc, graph, cipher } = setup();
    graph.subscribePageApp.mockResolvedValue(undefined);
    await expect(svc.subscribe(page())).resolves.toEqual({
      kind: 'subscribed',
    });
    expect(cipher.decrypt).toHaveBeenCalledWith(
      CIPHERTEXT,
      tokenCipherContext('meta_page_token', WS, PAGE_ID),
    );
    expect(graph.subscribePageApp).toHaveBeenCalledWith(PAGE_ID, TOKEN);
    expect(q.markConnectionNeedsReauth).not.toHaveBeenCalled();
  });

  it('undecryptable token → result, no Graph call', async () => {
    const { svc, graph, cipher } = setup();
    cipher.decrypt.mockImplementation(() => {
      throw new TokenDecryptionError('auth_failed');
    });
    await expect(svc.subscribe(page())).resolves.toEqual({
      kind: 'undecryptable',
    });
    expect(graph.subscribePageApp).not.toHaveBeenCalled();
    expect(warnings.join('\n')).toMatch(/cannot be decrypted/);
  });

  it('token_invalid → marks the connection NEEDS_REAUTH (conditioned on the token used)', async () => {
    const { svc, db, graph } = setup();
    graph.subscribePageApp.mockRejectedValue(
      new MetaGraphError('token_invalid', 'Meta Graph 400 (#190): expired', {
        status: 400,
        code: 190,
      }),
    );
    q.markConnectionNeedsReauth.mockResolvedValue(true);
    await expect(svc.subscribe(page(), () => NOW)).resolves.toEqual({
      kind: 'graph_failed',
      errorKind: 'token_invalid',
      connectionMarked: true,
    });
    expect(q.markConnectionNeedsReauth).toHaveBeenCalledWith(db, {
      workspaceId: WS,
      pageRowId: ROW,
      observedPageToken: CIPHERTEXT,
      now: NOW,
    });
    expect(warnings.join('\n')).toMatch(
      /subscribe failed \(token_invalid #190\)/,
    );
    expect(warnings.join('\n')).toMatch(/NEEDS_REAUTH/);
  });

  it('token_invalid when the row was already NEEDS_REAUTH/REVOKED → connectionMarked false', async () => {
    const { svc, graph } = setup();
    graph.subscribePageApp.mockRejectedValue(
      new MetaGraphError('token_invalid', 'x', { code: 190 }),
    );
    q.markConnectionNeedsReauth.mockResolvedValue(false);
    await expect(svc.subscribe(page())).resolves.toMatchObject({
      connectionMarked: false,
    });
  });

  it.each([
    'rate_limited',
    'permission',
    'transient',
    'network',
    'unexpected_response',
  ] as const)('%s → graph_failed, connection untouched', async (kind) => {
    const { svc, graph } = setup();
    graph.subscribePageApp.mockRejectedValue(new MetaGraphError(kind, 'x'));
    await expect(svc.subscribe(page())).resolves.toEqual({
      kind: 'graph_failed',
      errorKind: kind,
      connectionMarked: false,
    });
    expect(q.markConnectionNeedsReauth).not.toHaveBeenCalled();
  });

  it('a non-Graph error propagates', async () => {
    const { svc, graph } = setup();
    graph.subscribePageApp.mockRejectedValue(new Error('bug'));
    await expect(svc.subscribe(page())).rejects.toThrow('bug');
  });
});

describe('PageSubscriptionService.unsubscribeBestEffort', () => {
  it('re-reads the Page (scoped) and unsubscribes an inactive Page with a token', async () => {
    const { svc, db, graph } = setup();
    q.findWorkspacePageToken.mockResolvedValue(page());
    graph.unsubscribePageApp.mockResolvedValue(undefined);
    await expect(svc.unsubscribeBestEffort(WS, ROW)).resolves.toBe(true);
    expect(q.findWorkspacePageToken).toHaveBeenCalledWith(db, WS, ROW);
    expect(graph.unsubscribePageApp).toHaveBeenCalledWith(PAGE_ID, TOKEN);
  });

  it.each([
    ['gone', undefined],
    ['active again', page({ isActive: true })],
    ['without a token', { ...page(), encryptedPageAccessToken: null }],
  ])('skips a Page that is %s', async (_label, row) => {
    const { svc, graph } = setup();
    q.findWorkspacePageToken.mockResolvedValue(row);
    await expect(svc.unsubscribeBestEffort(WS, ROW)).resolves.toBe(false);
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
  });

  it('skips without reading when Meta or the cipher is unset', async () => {
    for (const options of [{ graph: false }, { cipher: false }]) {
      vi.resetAllMocks();
      const { svc, graph } = setup(options);
      await expect(svc.unsubscribeBestEffort(WS, ROW)).resolves.toBe(false);
      expect(q.findWorkspacePageToken).not.toHaveBeenCalled();
      expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
    }
  });

  it('Graph failure → false (never throws); token_invalid also marks NEEDS_REAUTH', async () => {
    const { svc, graph } = setup();
    q.findWorkspacePageToken.mockResolvedValue(page());
    graph.unsubscribePageApp.mockRejectedValueOnce(
      new MetaGraphError('transient', 'x'),
    );
    await expect(svc.unsubscribeBestEffort(WS, ROW)).resolves.toBe(false);
    expect(q.markConnectionNeedsReauth).not.toHaveBeenCalled();
    graph.unsubscribePageApp.mockRejectedValueOnce(
      new MetaGraphError('token_invalid', 'x', { code: 190 }),
    );
    q.markConnectionNeedsReauth.mockResolvedValue(true);
    await expect(svc.unsubscribeBestEffort(WS, ROW)).resolves.toBe(false);
    expect(q.markConnectionNeedsReauth).toHaveBeenCalledTimes(1);
    expect(warnings.join('\n')).toMatch(/unsubscribe failed \(transient\)/);
  });

  it('DB or unexpected errors are swallowed and logged with ids only', async () => {
    const { svc } = setup();
    q.findWorkspacePageToken.mockRejectedValue(new Error(`boom ${TOKEN}`));
    await expect(svc.unsubscribeBestEffort(WS, ROW)).resolves.toBe(false);
    expect(warnings.join('\n')).toContain(`Page ${ROW} (workspace ${WS})`);
  });

  it('undecryptable token → false, no Graph call', async () => {
    const { svc, graph, cipher } = setup();
    q.findWorkspacePageToken.mockResolvedValue(page());
    cipher.decrypt.mockImplementation(() => {
      throw new TokenDecryptionError('unknown_key');
    });
    await expect(svc.unsubscribeBestEffort(WS, ROW)).resolves.toBe(false);
    expect(graph.unsubscribePageApp).not.toHaveBeenCalled();
  });
});
