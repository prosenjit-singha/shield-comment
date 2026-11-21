import { type INestApplication, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type {
  AiSettingsAuditList,
  AiSettingsResponse,
} from '../src/admin/dto/ai-settings.dto.js';
import { AiGatewayService } from '../src/ai-gateway/ai-gateway.service.js';
import {
  DEFAULT_AI_BASE_URLS,
  DEFAULT_AI_MODELS,
} from '../src/ai-gateway/ai-provider.js';
import {
  AI_ENV_SETTINGS,
  type AiEnvSettings,
  aiProviderKeyContext,
} from '../src/ai-gateway/ai-settings.rules.js';
import { DbAiConfigResolver } from '../src/ai-gateway/db-ai-config.resolver.js';
import {
  DEFAULT_TEXT_IMAGE_MODEL,
  NEON_MODEL_CATALOG,
} from '../src/ai-gateway/neon-model-catalog.js';
import { TOKEN_KEYRING } from '../src/crypto/token-cipher.config.js';
import { TokenCipherService } from '../src/crypto/token-cipher.service.js';
import {
  aiProviderKeys,
  aiProviderSettings,
  aiSettingsAuditLogs,
} from '../src/db/schema/index.js';
import {
  type Actor,
  createAuthActors,
  withAuditMaintenance,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { type FakeAiGateway, fakeAiGateway } from './utils/fake-ai-gateway.js';

const BASE = '/api/admin/settings/ai';
const ENV_KEY = 'sk-env-openai-key-ENV9';
const DB_KEY = 'sk-db-openai-key-AB12';
const DB_KEY_2 = 'sk-db-openai-key-CD34';
const ANTHROPIC_KEY = 'sk-ant-db-key-EF56';
const DRAFT_KEY = 'sk-draft-key-GH78';
const SECRETS = [ENV_KEY, DB_KEY, DB_KEY_2, ANTHROPIC_KEY, DRAFT_KEY];

/** `.env` side for this spec: OpenAI with a key and a model, nothing else. */
const ENV: AiEnvSettings = {
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: ENV_KEY,
  AI_GATEWAY_MODEL: 'gpt-env-model',
};

const LOG_METHODS = ['log', 'warn', 'error', 'debug', 'verbose'] as const;

/**
 * M5-T3 (D16): AI provider settings API + DB-backed resolver (DB → `.env` per field). The
 * gateway is the strict fake (no live LLM call). Every test leaves the settings tables empty.
 */
describe('Admin AI provider settings (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let ai: FakeAiGateway;
  let superAdmin: Actor;
  let client: Actor;
  const logged: string[] = [];
  const http = () => actors.http();

  const get = () =>
    http().get(BASE).set('Cookie', superAdmin.cookie).expect(200);
  const patch = (body: unknown, cookie = superAdmin.cookie) =>
    http()
      .patch(BASE)
      .set('Cookie', cookie)
      .set('User-Agent', 'm5t3-e2e')
      .send(body as object);
  const probe = (body: unknown = {}) =>
    http()
      .post(`${BASE}/test`)
      .set('Cookie', superAdmin.cookie)
      .send(body as object);
  const auditRows = () =>
    actors.db
      .select()
      .from(aiSettingsAuditLogs)
      .where(eq(aiSettingsAuditLogs.adminId, superAdmin.id))
      .orderBy(
        desc(aiSettingsAuditLogs.createdAt),
        desc(aiSettingsAuditLogs.id),
      );
  const fieldsOf = (
    rows: { field: string; before: string | null; after: string | null }[],
  ) =>
    rows
      .map(({ field, before, after }) => ({ field, before, after }))
      .sort((a, b) => a.field.localeCompare(b.field));
  const expectNoSecret = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  };

  beforeAll(async () => {
    ai = fakeAiGateway();
    app = await createTestApp((b) =>
      b
        .overrideProvider(AiGatewayService)
        .useValue(ai)
        .overrideProvider(AI_ENV_SETTINGS)
        .useValue(ENV),
    );
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m5t3-super');
    client = await actors.signUp('m5t3-client');
    for (const method of LOG_METHODS) {
      vi.spyOn(Logger.prototype, method).mockImplementation(
        (...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        },
      );
    }
  });

  afterEach(async () => {
    await actors.db.delete(aiProviderKeys);
    await actors.db.delete(aiProviderSettings);
    await withAuditMaintenance(actors.db, (tx) =>
      tx
        .delete(aiSettingsAuditLogs)
        .where(eq(aiSettingsAuditLogs.adminId, superAdmin.id)),
    );
    app.get(DbAiConfigResolver).invalidate();
    expect(ai.pending).toBe(0);
    ai.reset();
  });

  afterAll(async () => {
    // No key ever reached a Nest logger line during this spec.
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      for (const secret of SECRETS) expect(line).not.toContain(secret);
    }
    vi.restoreAllMocks();
    await actors?.cleanup();
    await app?.close();
  });

  describe('access', () => {
    const routes = [
      ['get', BASE],
      ['patch', BASE],
      ['post', `${BASE}/test`],
      ['get', `${BASE}/audit`],
    ] as const;

    it.each(routes)('%s %s: 401 anonymous', async (method, path) => {
      await http()[method](path).send({ model: 'x' }).expect(401);
    });

    it.each(routes)(
      '%s %s: 403 for a non-super-admin',
      async (method, path) => {
        await http()
          [method](path)
          .set('Cookie', client.cookie)
          .send({ model: 'x' })
          .expect(403);
      },
    );

    it('a refused PATCH changes nothing', async () => {
      await patch({ keys: { openai: DB_KEY } }, client.cookie).expect(403);
      expect(await actors.db.select().from(aiProviderKeys)).toEqual([]);
    });
  });

  describe('GET', () => {
    it('empty DB: everything from .env / defaults, keys masked by source', async () => {
      const { body } = await get();
      const res = body as AiSettingsResponse;
      expect(res).toMatchObject({
        provider: 'openai',
        providerSource: 'env',
        model: 'gpt-env-model',
        modelSource: 'env',
        configured: true,
        cipherConfigured: true,
        updatedAt: null,
        updatedBy: null,
      });
      expect(res.providers.openai).toEqual({
        defaultModel: DEFAULT_AI_MODELS.openai,
        model: 'gpt-env-model',
        modelSource: 'env',
        baseUrlConfigured: true,
        key: {
          configured: true,
          source: 'env',
          last4: 'ENV9',
          unreadable: false,
          updatedAt: null,
        },
      });
      expect(res.providers.neon).toMatchObject({
        model: DEFAULT_AI_MODELS.neon,
        modelSource: 'default',
        baseUrlConfigured: false,
        key: { configured: false, source: 'none', last4: null },
      });
      expect(res.providers.anthropic.key.source).toBe('none');
      expect(res.providers.google.key.source).toBe('none');
      expectNoSecret(res);
    });

    it('env fallback reaches the resolver when the DB is empty', async () => {
      expect(await app.get(DbAiConfigResolver).resolve()).toEqual({
        provider: 'openai',
        model: 'gpt-env-model',
        apiKey: ENV_KEY,
        baseUrl: DEFAULT_AI_BASE_URLS.openai,
      });
    });
  });

  describe('PATCH keys', () => {
    it('set → encrypted row + masked status (db) + audit set; resolver sees it at once', async () => {
      const resolver = app.get(DbAiConfigResolver);
      expect((await resolver.resolve())?.apiKey).toBe(ENV_KEY); // cached now
      const { body } = await patch({ keys: { openai: ` ${DB_KEY} ` } }).expect(
        200,
      );
      const res = body as AiSettingsResponse;
      expect(res.providers.openai.key).toMatchObject({
        configured: true,
        source: 'db',
        last4: 'AB12',
        unreadable: false,
      });
      expect(res.providers.openai.key.updatedAt).toEqual(expect.any(String));
      expectNoSecret(res);

      const [row] = await actors.db.select().from(aiProviderKeys);
      expect(row).toMatchObject({
        provider: 'openai',
        last4: 'AB12',
        updatedById: superAdmin.id,
      });
      expect(row!.keyCiphertext).toMatch(/^v1:e2e:/);
      expect(row!.keyCiphertext).not.toContain(DB_KEY);
      expect(
        app
          .get(TokenCipherService)
          .decrypt(row!.keyCiphertext, aiProviderKeyContext('openai')),
      ).toBe(DB_KEY);
      // Key-only change: no settings row.
      expect(await actors.db.select().from(aiProviderSettings)).toEqual([]);

      const audit = await auditRows();
      expect(fieldsOf(audit)).toEqual([
        { field: 'key.openai', before: null, after: 'set' },
      ]);
      expect(audit[0]).toMatchObject({ userAgent: 'm5t3-e2e' });
      expectNoSecret(audit);

      // The PATCH invalidated the cached env config.
      expect((await resolver.resolve())?.apiKey).toBe(DB_KEY);
    });

    it('replace = set → set, same key again = no-op, clear = set → cleared (env key back)', async () => {
      await patch({ keys: { openai: DB_KEY } }).expect(200);
      await patch({ keys: { openai: DB_KEY_2 } }).expect(200);
      const before = await auditRows();
      expect(before.map((r) => [r.field, r.before, r.after])).toEqual([
        ['key.openai', 'set', 'set'],
        ['key.openai', null, 'set'],
      ]);
      const { body: same } = await patch({ keys: { openai: DB_KEY_2 } }).expect(
        200,
      );
      expect((same as AiSettingsResponse).providers.openai.key.last4).toBe(
        'CD34',
      );
      expect(await auditRows()).toHaveLength(2);

      const { body } = await patch({ keys: { openai: null } }).expect(200);
      expect((body as AiSettingsResponse).providers.openai.key).toMatchObject({
        source: 'env',
        last4: 'ENV9',
        updatedAt: null,
      });
      expect(await actors.db.select().from(aiProviderKeys)).toEqual([]);
      expect((await auditRows())[0]).toMatchObject({
        field: 'key.openai',
        before: 'set',
        after: 'cleared',
      });
      expect((await app.get(DbAiConfigResolver).resolve())?.apiKey).toBe(
        ENV_KEY,
      );

      // Clearing a key the DB doesn't hold: no-op, no audit row.
      await patch({ keys: { openai: null } }).expect(200);
      expect(await auditRows()).toHaveLength(3);
    });

    it('several keys in one PATCH → one audit row each', async () => {
      await patch({
        keys: { openai: DB_KEY, anthropic: ANTHROPIC_KEY, google: null },
      }).expect(200);
      expect(fieldsOf(await auditRows())).toEqual([
        { field: 'key.anthropic', before: null, after: 'set' },
        { field: 'key.openai', before: null, after: 'set' },
      ]);
    });
  });

  describe('PATCH provider / model', () => {
    it('provider + model saved, audited, and used by the resolver', async () => {
      await patch({ keys: { anthropic: ANTHROPIC_KEY } }).expect(200);
      const { body } = await patch({
        provider: 'anthropic',
        model: 'claude-test-model',
      }).expect(200);
      const res = body as AiSettingsResponse;
      expect(res).toMatchObject({
        provider: 'anthropic',
        providerSource: 'db',
        model: 'claude-test-model',
        modelSource: 'db',
        configured: true,
        updatedBy: { id: superAdmin.id, email: superAdmin.email },
      });
      expect(res.updatedAt).toEqual(expect.any(String));
      // The env model stays with the env provider.
      expect(res.providers.openai).toMatchObject({
        model: 'gpt-env-model',
        modelSource: 'env',
      });
      expect(fieldsOf((await auditRows()).slice(0, 2))).toEqual([
        { field: 'model', before: null, after: 'claude-test-model' },
        { field: 'provider', before: null, after: 'anthropic' },
      ]);
      expect(await app.get(DbAiConfigResolver).resolve()).toEqual({
        provider: 'anthropic',
        model: 'claude-test-model',
        apiKey: ANTHROPIC_KEY,
        baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      });
    });

    it('switching provider without a model resets the model (audited)', async () => {
      await patch({ provider: 'anthropic', model: 'claude-test-model' }).expect(
        200,
      );
      const { body } = await patch({ provider: 'google' }).expect(200);
      expect(body as AiSettingsResponse).toMatchObject({
        provider: 'google',
        model: DEFAULT_AI_MODELS.google,
        modelSource: 'default',
        configured: false,
      });
      expect(fieldsOf((await auditRows()).slice(0, 2))).toEqual([
        { field: 'model', before: 'claude-test-model', after: null },
        { field: 'provider', before: 'anthropic', after: 'google' },
      ]);
    });

    it('model only (no DB provider) applies to the env provider; same values = no-op', async () => {
      const { body } = await patch({ model: ' gpt-db-model ' }).expect(200);
      expect(body as AiSettingsResponse).toMatchObject({
        provider: 'openai',
        providerSource: 'env',
        model: 'gpt-db-model',
        modelSource: 'db',
      });
      // Pinning the env provider keeps the model (same effective provider).
      await patch({ provider: 'openai' }).expect(200);
      await patch({ provider: 'openai', model: 'gpt-db-model' }).expect(200);
      expect(fieldsOf(await auditRows())).toEqual([
        { field: 'model', before: null, after: 'gpt-db-model' },
        { field: 'provider', before: null, after: 'openai' },
      ]);
      const { body: cleared } = await patch({ model: null }).expect(200);
      // Cleared DB model → the env model of the env provider.
      expect(cleared as AiSettingsResponse).toMatchObject({
        model: 'gpt-env-model',
        modelSource: 'env',
      });
    });
  });

  describe('Text + Image model, switch and Neon catalog (M5-T15b)', () => {
    it('GET: default Text + Image model, switch off, the Neon catalog', async () => {
      const res = (await get()).body as AiSettingsResponse;
      expect(res).toMatchObject({
        textImageModel: DEFAULT_TEXT_IMAGE_MODEL,
        textImageModelSource: 'default',
        textImageEnabled: false,
      });
      expect(res.catalog).toEqual(NEON_MODEL_CATALOG);
      expect(res.providers.neon.defaultModel).toBe('typesafeai-jev-1-14-0');
    });

    it('neon: catalog models + switch saved, one audit row per field', async () => {
      const { body } = await patch({
        provider: 'neon',
        model: 'gpt-oss-20b',
        textImageModel: 'gemini-4-carbon',
        textImageEnabled: true,
      }).expect(200);
      expect(body as AiSettingsResponse).toMatchObject({
        provider: 'neon',
        model: 'gpt-oss-20b',
        modelSource: 'db',
        textImageModel: 'gemini-4-carbon',
        textImageModelSource: 'db',
        textImageEnabled: true,
      });
      expect(fieldsOf(await auditRows())).toEqual([
        { field: 'model', before: null, after: 'gpt-oss-20b' },
        { field: 'provider', before: null, after: 'neon' },
        { field: 'text_image_enabled', before: 'false', after: 'true' },
        { field: 'text_image_model', before: null, after: 'gemini-4-carbon' },
      ]);
      // Same values again = no-op; the switch alone is one row.
      await patch({ textImageEnabled: true }).expect(200);
      const { body: off } = await patch({ textImageEnabled: false }).expect(
        200,
      );
      expect((off as AiSettingsResponse).textImageEnabled).toBe(false);
      const rows = await auditRows();
      expect(rows).toHaveLength(5);
      expect(fieldsOf(rows.slice(0, 1))).toEqual([
        { field: 'text_image_enabled', before: 'true', after: 'false' },
      ]);
    });

    it('null resets the Text + Image model to the default (audited)', async () => {
      await patch({
        provider: 'neon',
        textImageModel: 'typesafeai-jev-1-14-0',
      }).expect(200);
      const { body } = await patch({ textImageModel: null }).expect(200);
      expect(body as AiSettingsResponse).toMatchObject({
        textImageModel: DEFAULT_TEXT_IMAGE_MODEL,
        textImageModelSource: 'default',
      });
      expect(fieldsOf((await auditRows()).slice(0, 1))).toEqual([
        {
          field: 'text_image_model',
          before: 'typesafeai-jev-1-14-0',
          after: null,
        },
      ]);
    });

    it.each([
      [{ provider: 'neon', model: 'gpt-unknown' }, 'UNKNOWN_AI_MODEL'],
      [{ provider: 'neon', textImageModel: 'nope-1' }, 'UNKNOWN_AI_MODEL'],
      [
        { provider: 'neon', textImageModel: 'gpt-oss-120b' },
        'MODEL_NOT_IMAGE_CAPABLE',
      ],
    ])('400 for %j (%s), nothing written', async (body, code) => {
      const res = await patch(body).expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, code });
      expect(await actors.db.select().from(aiProviderSettings)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it('a saved neon provider checks later model-only patches too', async () => {
      await patch({ provider: 'neon' }).expect(200);
      const res = await patch({ textImageModel: 'gpt-oss-20b' }).expect(400);
      expect(res.body).toMatchObject({ code: 'MODEL_NOT_IMAGE_CAPABLE' });
    });

    it('direct providers (env openai) are not checked against the Neon catalog', async () => {
      const { body } = await patch({ textImageModel: 'gpt-4.1-mini' }).expect(
        200,
      );
      expect((body as AiSettingsResponse).textImageModel).toBe('gpt-4.1-mini');
    });
  });

  describe('PATCH validation', () => {
    it.each([
      [{}, 'Nothing to update'],
      [{ keys: {} }, 'Nothing to update'],
      [{ provider: 'mistral' }, 'provider'],
      [{ provider: null }, 'provider'],
      [{ model: '' }, 'model'],
      [{ model: 'x'.repeat(101) }, 'model'],
      [{ keys: { openai: 'short' } }, 'openai'],
      [{ keys: { openai: 'has space 1234' } }, 'openai'],
      [{ keys: { mistral: DB_KEY } }, 'mistral'],
      [{ apiKey: DB_KEY }, 'apiKey'],
      [{ textImageModel: '' }, 'textImageModel'],
      [{ textImageEnabled: null }, 'textImageEnabled'],
      [{ textImageEnabled: 'yes' }, 'textImageEnabled'],
    ])('400 for %j', async (body, hint) => {
      const res = await patch(body).expect(400);
      expect(JSON.stringify(res.body)).toContain(hint);
      expectNoSecret(res.body);
    });

    it('a 400 writes nothing', async () => {
      await patch({ provider: 'anthropic', keys: { openai: 'x' } }).expect(400);
      expect(await actors.db.select().from(aiProviderSettings)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });
  });

  describe('POST /test', () => {
    it('saved config by default; returns the probe result only', async () => {
      await patch({ keys: { openai: DB_KEY } }).expect(200);
      ai.connectionResult({
        ok: true,
        provider: 'openai',
        model: 'gpt-env-model',
        latencyMs: 42,
      });
      const { body } = await probe().expect(200);
      expect(body).toEqual({
        ok: true,
        provider: 'openai',
        model: 'gpt-env-model',
        latencyMs: 42,
      });
      expect(ai.testConnection).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'gpt-env-model',
        apiKey: DB_KEY,
        baseUrl: DEFAULT_AI_BASE_URLS.openai,
      });
    });

    it('draft provider/model/key merged over the saved config; failure passed through', async () => {
      ai.connectionResult({
        ok: false,
        kind: 'auth',
        latencyMs: 7,
        provider: 'anthropic',
        model: 'claude-draft',
        message: 'invalid x-api-key',
      });
      const { body } = await probe({
        provider: 'anthropic',
        model: 'claude-draft',
        apiKey: DRAFT_KEY,
      }).expect(200);
      expect(body).toMatchObject({ ok: false, kind: 'auth' });
      expectNoSecret(body);
      expect(ai.testConnection).toHaveBeenCalledWith({
        provider: 'anthropic',
        model: 'claude-draft',
        apiKey: DRAFT_KEY,
        baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      });
      // A draft never saves anything.
      expect(await actors.db.select().from(aiProviderKeys)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it('draft key only: keeps the saved provider + model', async () => {
      ai.connectionResult({
        ok: true,
        provider: 'openai',
        model: 'gpt-env-model',
        latencyMs: 3,
      });
      await probe({ apiKey: DRAFT_KEY }).expect(200);
      expect(ai.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', apiKey: DRAFT_KEY }),
      );
    });

    it('no key for the provider → not_configured without a probe', async () => {
      const { body } = await probe({ provider: 'google' }).expect(200);
      expect(body).toEqual({
        ok: false,
        kind: 'not_configured',
        latencyMs: 0,
        provider: 'google',
        model: DEFAULT_AI_MODELS.google,
      });
      expect(ai.testConnection).not.toHaveBeenCalled();
    });

    it('400 on an invalid draft', async () => {
      await probe({ provider: 'x' }).expect(400);
      await probe({ apiKey: 'short' }).expect(400);
      await probe({ keys: {} }).expect(400);
      expect(ai.testConnection).not.toHaveBeenCalled();
    });
  });

  describe('GET /audit', () => {
    it('newest first, paged, with the admin; never a key', async () => {
      await patch({ keys: { openai: DB_KEY } }).expect(200);
      await patch({ model: 'gpt-db-model' }).expect(200);
      await patch({ keys: { openai: null } }).expect(200);
      const { body } = await http()
        .get(`${BASE}/audit?take=2`)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const list = body as AiSettingsAuditList;
      expect(list.total).toBeGreaterThanOrEqual(3);
      expect(list).toMatchObject({ skip: 0, take: 2 });
      expect(list.items.map((i) => [i.field, i.before, i.after])).toEqual([
        ['key.openai', 'set', 'cleared'],
        ['model', null, 'gpt-db-model'],
      ]);
      expect(list.items[0]).toMatchObject({
        admin: { id: superAdmin.id, email: superAdmin.email },
        userAgent: 'm5t3-e2e',
        createdAt: expect.any(String),
      });
      expectNoSecret(list);
      const { body: next } = await http()
        .get(`${BASE}/audit?skip=2&take=1`)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect(
        (next as AiSettingsAuditList).items.map((i) => [i.field, i.after]),
      ).toEqual([['key.openai', 'set']]);
    });

    it('400 on bad paging or unknown params', async () => {
      for (const q of ['take=0', 'take=101', 'skip=-1', 'planId=x']) {
        await http()
          .get(`${BASE}/audit?${q}`)
          .set('Cookie', superAdmin.cookie)
          .expect(400);
      }
    });
  });
});

describe('Admin AI provider settings without a token cipher (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let superAdmin: Actor;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(TOKEN_KEYRING)
        .useFactory({ factory: () => null })
        .overrideProvider(AiGatewayService)
        .useValue(fakeAiGateway())
        .overrideProvider(AI_ENV_SETTINGS)
        .useValue({}),
    );
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m5t3-nocipher');
  });

  afterAll(async () => {
    await actors.db.delete(aiProviderSettings);
    await actors?.cleanup();
    await app?.close();
  });

  it('GET says keys cannot be saved; nothing configured', async () => {
    const { body } = await actors
      .http()
      .get(BASE)
      .set('Cookie', superAdmin.cookie)
      .expect(200);
    expect(body as AiSettingsResponse).toMatchObject({
      provider: 'neon',
      providerSource: 'default',
      configured: false,
      cipherConfigured: false,
    });
  });

  it('503 KEY_ENCRYPTION_NOT_CONFIGURED on a key save, nothing written', async () => {
    const res = await actors
      .http()
      .patch(BASE)
      .set('Cookie', superAdmin.cookie)
      .send({ provider: 'openai', keys: { openai: DB_KEY } })
      .expect(503);
    expect(res.body).toMatchObject({
      statusCode: 503,
      code: 'KEY_ENCRYPTION_NOT_CONFIGURED',
    });
    expect(JSON.stringify(res.body)).not.toContain(DB_KEY);
    expect(await actors.db.select().from(aiProviderKeys)).toEqual([]);
    expect(await actors.db.select().from(aiProviderSettings)).toEqual([]);
  });

  it('provider/model changes and key clears still work', async () => {
    await actors
      .http()
      .patch(BASE)
      .set('Cookie', superAdmin.cookie)
      .send({ provider: 'google', keys: { google: null } })
      .expect(200);
    const rows = await actors.db
      .select()
      .from(aiSettingsAuditLogs)
      .where(eq(aiSettingsAuditLogs.adminId, superAdmin.id));
    expect(rows.map((r) => [r.field, r.after])).toEqual([
      ['provider', 'google'],
    ]);
  });
});
