import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import { buildTokenKeyring } from '../src/crypto/token-keyring.js';
import {
  metaConnections,
  socialPages,
  workspaces,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/** Postgres SQLSTATE of a failed query (Drizzle wraps the `pg` error in `cause`). */
async function pgCode(
  query: PromiseLike<unknown>,
): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    const pgError = (error as { cause?: { code?: string } }).cause ?? error;
    return (pgError as { code?: string }).code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/**
 * M3-T2: `meta_connections` + `social_pages` constraints (user decisions 2026-11-18: D7 one
 * connection per workspace + globally unique Page/IG ids, D8 status column, D4 IG columns +
 * granted scopes, D2 ciphertext-only token columns). No HTTP routes yet (M3-T4…T6).
 */
describe('Meta schema (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let a: Actor;
  let b: Actor;

  // Unique per run so parallel/stale rows can't collide with the global unique keys.
  const base = `9${Date.now()}`;
  const fbUserId = `${base}1`;
  const pageA = `${base}2`;
  const pageB = `${base}3`;
  const igA = `${base}4`;

  const cipher = new TokenCipherService(
    buildTokenKeyring({
      key: randomBytes(32).toString('base64'),
      keyId: 'e2e',
    }),
  );
  const userToken = (workspaceId: string) =>
    cipher.encrypt(
      'EAAG-user-token',
      tokenCipherContext('meta_user_token', workspaceId, fbUserId),
    );
  const pageToken = (workspaceId: string, pageId: string) =>
    cipher.encrypt(
      'EAAG-page-token',
      tokenCipherContext('meta_page_token', workspaceId, pageId),
    );

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    a = await actors.signUp('m3t2-a');
    b = await actors.signUp('m3t2-b');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  const db = () => actors.db;

  describe('meta_connections', () => {
    it('stores an encrypted connection with defaults (ACTIVE, empty scopes)', async () => {
      const [row] = await db()
        .insert(metaConnections)
        .values({
          workspaceId: a.workspaceId,
          facebookUserId: fbUserId,
          encryptedUserAccessToken: userToken(a.workspaceId),
        })
        .returning();
      expect(row).toMatchObject({
        status: 'ACTIVE',
        grantedScopes: [],
        tokenExpiresAt: null,
      });
      expect(row!.statusChangedAt).toBeInstanceOf(Date);
      expect(
        cipher.decrypt(
          row!.encryptedUserAccessToken!,
          tokenCipherContext('meta_user_token', a.workspaceId, fbUserId),
        ),
      ).toBe('EAAG-user-token');
    });

    it('allows only one connection per workspace (D7)', async () => {
      expect(
        await pgCode(
          db()
            .insert(metaConnections)
            .values({
              workspaceId: a.workspaceId,
              facebookUserId: fbUserId,
              encryptedUserAccessToken: userToken(a.workspaceId),
            }),
        ),
      ).toBe(UNIQUE_VIOLATION);
    });

    it('re-connect upserts on workspace_id (no duplicate row)', async () => {
      await db()
        .insert(metaConnections)
        .values({
          workspaceId: a.workspaceId,
          facebookUserId: fbUserId,
          encryptedUserAccessToken: userToken(a.workspaceId),
          grantedScopes: ['pages_show_list', 'instagram_manage_comments'],
        })
        .onConflictDoUpdate({
          target: metaConnections.workspaceId,
          set: {
            grantedScopes: ['pages_show_list', 'instagram_manage_comments'],
          },
        });
      const rows = await db()
        .select()
        .from(metaConnections)
        .where(eq(metaConnections.workspaceId, a.workspaceId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.grantedScopes).toEqual([
        'pages_show_list',
        'instagram_manage_comments',
      ]);
    });

    it('rejects an unknown status, a plaintext token and a non-numeric FB user id', async () => {
      const valid = {
        workspaceId: b.workspaceId,
        facebookUserId: fbUserId,
        encryptedUserAccessToken: userToken(b.workspaceId),
      };
      expect(
        await pgCode(
          db()
            .insert(metaConnections)
            .values({ ...valid, status: 'EXPIRED' as 'ACTIVE' }),
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await pgCode(
          db()
            .insert(metaConnections)
            .values({ ...valid, encryptedUserAccessToken: 'EAAG-plaintext' }),
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await pgCode(
          db()
            .insert(metaConnections)
            .values({ ...valid, facebookUserId: 'me' }),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('rejects an unknown workspace (FK)', async () => {
      expect(
        await pgCode(
          db().insert(metaConnections).values({
            workspaceId: '0193b1a2-0000-7000-8000-00000000dead',
            facebookUserId: fbUserId,
            encryptedUserAccessToken: 'v1:x',
          }),
        ),
      ).toBe(FK_VIOLATION);
    });
  });

  describe('social_pages', () => {
    it('stores pages with and without a linked IG account', async () => {
      const rows = await db()
        .insert(socialPages)
        .values([
          {
            workspaceId: a.workspaceId,
            pageId: pageA,
            pageName: 'Shop A',
            igBusinessId: igA,
            igUsername: 'shop.a',
            encryptedPageAccessToken: pageToken(a.workspaceId, pageA),
            isActive: true,
          },
          {
            workspaceId: a.workspaceId,
            pageId: pageB,
            pageName: 'Shop B',
            encryptedPageAccessToken: pageToken(a.workspaceId, pageB),
          },
        ])
        .returning();
      expect(rows.map((r) => [r.pageId, r.igBusinessId, r.isActive])).toEqual([
        [pageA, igA, true],
        [pageB, null, false],
      ]);
    });

    it('a Page belongs to one workspace only (global page_id, D7)', async () => {
      expect(
        await pgCode(
          db().insert(socialPages).values({
            workspaceId: b.workspaceId,
            pageId: pageA,
            pageName: 'Stolen',
          }),
        ),
      ).toBe(UNIQUE_VIOLATION);
    });

    it('an IG Business account belongs to one Page only', async () => {
      expect(
        await pgCode(
          db()
            .insert(socialPages)
            .values({
              workspaceId: b.workspaceId,
              pageId: `${base}5`,
              pageName: 'Other',
              igBusinessId: igA,
            }),
        ),
      ).toBe(UNIQUE_VIOLATION);
    });

    it('a Page missing on re-connect can be kept inactive without a token (D7)', async () => {
      const [row] = await db()
        .update(socialPages)
        .set({ isActive: false, encryptedPageAccessToken: null })
        .where(eq(socialPages.pageId, pageA))
        .returning();
      expect(row).toMatchObject({
        isActive: false,
        encryptedPageAccessToken: null,
      });
    });

    it('rejects an active Page without a token, IG username without IG id, plaintext tokens', async () => {
      expect(
        await pgCode(
          db()
            .update(socialPages)
            .set({ isActive: true })
            .where(eq(socialPages.pageId, pageA)),
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await pgCode(
          db()
            .update(socialPages)
            .set({ igUsername: 'shop.b' })
            .where(eq(socialPages.pageId, pageB)),
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await pgCode(
          db()
            .update(socialPages)
            .set({ encryptedPageAccessToken: 'EAAG-plaintext' })
            .where(eq(socialPages.pageId, pageB)),
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('a workspace with Meta rows cannot be deleted (FK restrict)', async () => {
    expect(
      await pgCode(
        db().delete(workspaces).where(eq(workspaces.id, a.workspaceId)),
      ),
    ).toBe(FK_VIOLATION);
  });
});
