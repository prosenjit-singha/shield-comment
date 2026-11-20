import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { count, desc, eq, sql } from 'drizzle-orm';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service.js';
import {
  AI_PROVIDERS,
  type AiProvider,
  DEFAULT_AI_MODELS,
} from '../ai-gateway/ai-provider.js';
import {
  NEON_MODEL_CATALOG,
  neonModel,
  supportsImages,
} from '../ai-gateway/neon-model-catalog.js';
import {
  AI_ENV_SETTINGS,
  type AiConfigDraft,
  type AiEnvSettings,
  aiBaseUrlFor,
  aiProviderKeyContext,
  draftAiConfig,
  envAiProvider,
  keyLast4,
  snapshotConfig,
} from '../ai-gateway/ai-settings.rules.js';
import {
  type AiSettingsState,
  DbAiConfigResolver,
} from '../ai-gateway/db-ai-config.resolver.js';
import { TokenCipherService } from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import {
  type AiSettingsAuditField,
  aiProviderKeys,
  aiProviderSettings,
  aiSettingsAuditLogs,
  users,
} from '../db/schema/index.js';
import type {
  AiConnectionTestResponse,
  AiSettingsAuditList,
  AiSettingsResponse,
  ListAiSettingsAuditQueryDto,
  UpdateAiSettingsDto,
} from './dto/ai-settings.dto.js';

/** Who changed the AI settings and from where (audit row). */
export interface AiSettingsActor {
  adminId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

interface AiSettingsChange {
  field: AiSettingsAuditField;
  before: string | null;
  after: string | null;
}

/** Neon models must be catalog models; the Text + Image one must take images (D19/D22). */
function assertNeonModels(patch: UpdateAiSettingsDto): void {
  for (const code of [patch.model, patch.textImageModel]) {
    if (code && !neonModel(code)) {
      throw new BadRequestException({
        message: `Unknown Neon AI Gateway model: ${code}`,
        error: 'Bad Request',
        code: 'UNKNOWN_AI_MODEL',
      });
    }
  }
  if (patch.textImageModel && !supportsImages(patch.textImageModel)) {
    throw new BadRequestException({
      message: `${patch.textImageModel} does not take images`,
      error: 'Bad Request',
      code: 'MODEL_NOT_IMAGE_CAPABLE',
    });
  }
}

/** Transaction-scoped advisory lock: AI settings PATCHes run one at a time. */
const AI_SETTINGS_LOCK = sql`select pg_advisory_xact_lock(hashtextextended('ai_provider_settings', 0))`;

/**
 * A7 AI provider settings (M5-T3, D16): global platform config, super admin only (not tenant
 * data, so no `workspace_id`). Keys are encrypted with `TokenCipherService` and never returned;
 * every change writes one audit row per field (keys only `set` / `cleared`).
 */
@Injectable()
export class AdminAiSettingsService {
  private readonly logger = new Logger(AdminAiSettingsService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly resolver: DbAiConfigResolver,
    private readonly cipher: TokenCipherService,
    private readonly ai: AiGatewayService,
    @Inject(AI_ENV_SETTINGS) private readonly env: AiEnvSettings,
  ) {}

  async get(): Promise<AiSettingsResponse> {
    return this.toResponse(await this.resolver.state());
  }

  /**
   * Applies provider / model / key changes in one transaction (advisory lock), writes one audit
   * row per changed field, then drops the resolver cache. Same values = no-op (no row, no audit).
   * 400 empty body; 503 `KEY_ENCRYPTION_NOT_CONFIGURED` when a key is saved without a cipher.
   */
  async update(
    patch: UpdateAiSettingsDto,
    actor: AiSettingsActor,
  ): Promise<AiSettingsResponse> {
    const keyPatch = AI_PROVIDERS.flatMap((provider) => {
      const value = patch.keys?.[provider];
      return value === undefined ? [] : [{ provider, value }];
    });
    if (
      patch.provider === undefined &&
      patch.model === undefined &&
      patch.textImageModel === undefined &&
      patch.textImageEnabled === undefined &&
      keyPatch.length === 0
    ) {
      throw new BadRequestException('Nothing to update');
    }
    if (keyPatch.some((k) => k.value !== null) && !this.cipher.isConfigured) {
      throw new ServiceUnavailableException({
        message:
          'API keys cannot be saved: key encryption is not configured (TOKEN_ENCRYPTION_KEY)',
        error: 'Service Unavailable',
        code: 'KEY_ENCRYPTION_NOT_CONFIGURED',
      });
    }

    const changes = await this.db.transaction(async (tx) => {
      await tx.execute(AI_SETTINGS_LOCK);
      const [row] = await tx
        .select({
          provider: aiProviderSettings.provider,
          model: aiProviderSettings.model,
          textImageModel: aiProviderSettings.textImageModel,
          textImageEnabled: aiProviderSettings.textImageEnabled,
        })
        .from(aiProviderSettings)
        .where(eq(aiProviderSettings.id, 1));
      const keyRows = keyPatch.length
        ? await tx
            .select({
              provider: aiProviderKeys.provider,
              keyCiphertext: aiProviderKeys.keyCiphertext,
            })
            .from(aiProviderKeys)
        : [];
      const found: AiSettingsChange[] = [];

      // Provider + models + switch (one settings row).
      const before = {
        provider: row?.provider ?? null,
        model: row?.model ?? null,
        textImageModel: row?.textImageModel ?? null,
        textImageEnabled: row?.textImageEnabled ?? false,
      };
      const next = { ...before };
      if (patch.provider !== undefined) {
        const effective = before.provider ?? envAiProvider(this.env);
        next.provider = patch.provider;
        // A model belongs to its provider: switching without a model resets it.
        if (patch.model === undefined && patch.provider !== effective) {
          next.model = null;
        }
      }
      if (patch.model !== undefined) next.model = patch.model;
      if (patch.textImageModel !== undefined) {
        next.textImageModel = patch.textImageModel;
      }
      if (patch.textImageEnabled !== undefined) {
        next.textImageEnabled = patch.textImageEnabled;
      }
      if ((next.provider ?? envAiProvider(this.env)) === 'neon') {
        assertNeonModels(patch);
      }
      if (next.provider !== before.provider) {
        found.push({
          field: 'provider',
          before: before.provider,
          after: next.provider,
        });
      }
      if (next.model !== before.model) {
        found.push({ field: 'model', before: before.model, after: next.model });
      }
      if (next.textImageModel !== before.textImageModel) {
        found.push({
          field: 'text_image_model',
          before: before.textImageModel,
          after: next.textImageModel,
        });
      }
      if (next.textImageEnabled !== before.textImageEnabled) {
        found.push({
          field: 'text_image_enabled',
          before: String(before.textImageEnabled),
          after: String(next.textImageEnabled),
        });
      }
      if (found.length > 0) {
        const now = new Date();
        await tx
          .insert(aiProviderSettings)
          .values({ id: 1, ...next, updatedById: actor.adminId })
          .onConflictDoUpdate({
            target: aiProviderSettings.id,
            set: { ...next, updatedById: actor.adminId, updatedAt: now },
          });
      }

      // Keys (one row per provider; clear = delete).
      for (const { provider, value } of keyPatch) {
        const existing = keyRows.find((k) => k.provider === provider);
        const field = `key.${provider}` as const;
        if (value === null) {
          if (!existing) continue;
          await tx
            .delete(aiProviderKeys)
            .where(eq(aiProviderKeys.provider, provider));
          found.push({ field, before: 'set', after: 'cleared' });
          continue;
        }
        if (existing && this.holdsKey(provider, existing.keyCiphertext, value))
          continue;
        const values = {
          keyCiphertext: this.cipher.encrypt(
            value,
            aiProviderKeyContext(provider),
          ),
          last4: keyLast4(value),
          updatedById: actor.adminId,
        };
        await tx
          .insert(aiProviderKeys)
          .values({ provider, ...values })
          .onConflictDoUpdate({
            target: aiProviderKeys.provider,
            set: { ...values, updatedAt: new Date() },
          });
        found.push({ field, before: existing ? 'set' : null, after: 'set' });
      }

      if (found.length > 0) {
        await tx.insert(aiSettingsAuditLogs).values(
          found.map((change) => ({
            ...change,
            adminId: actor.adminId,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
          })),
        );
      }
      return found;
    });

    if (changes.length > 0) {
      this.resolver.invalidate();
      this.logger.log(
        `AI settings updated fields=${changes.map((c) => c.field).join(',')}`,
      );
    }
    return this.get();
  }

  /**
   * "Test connection": the saved config, or a draft merged over it (`draftAiConfig`). Missing key
   * (or Neon base URL) → `not_configured` without a call. Returns the probe result only.
   */
  async test(draft: AiConfigDraft): Promise<AiConnectionTestResponse> {
    const state = await this.resolver.state();
    const config = draftAiConfig(state, draft);
    if (!config) {
      const provider = draft.provider ?? state.provider;
      return {
        ok: false,
        kind: 'not_configured',
        latencyMs: 0,
        provider,
        model: draft.model ?? state.models[provider].model,
      };
    }
    return this.ai.testConnection(config);
  }

  /** Change history, newest first (`created_at desc, id desc`). */
  async listAudit(
    query: ListAiSettingsAuditQueryDto,
  ): Promise<AiSettingsAuditList> {
    const [rows, [totals]] = await Promise.all([
      this.db
        .select({
          id: aiSettingsAuditLogs.id,
          field: aiSettingsAuditLogs.field,
          before: aiSettingsAuditLogs.before,
          after: aiSettingsAuditLogs.after,
          ip: aiSettingsAuditLogs.ipAddress,
          userAgent: aiSettingsAuditLogs.userAgent,
          createdAt: aiSettingsAuditLogs.createdAt,
          admin: { id: users.id, name: users.name, email: users.email },
        })
        .from(aiSettingsAuditLogs)
        .innerJoin(users, eq(users.id, aiSettingsAuditLogs.adminId))
        .orderBy(
          desc(aiSettingsAuditLogs.createdAt),
          desc(aiSettingsAuditLogs.id),
        )
        .offset(query.skip)
        .limit(query.take),
      this.db.select({ total: count() }).from(aiSettingsAuditLogs),
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      total: totals?.total ?? 0,
      skip: query.skip,
      take: query.take,
    };
  }

  /** True when the stored ciphertext decrypts to `value` (saving the same key again is a no-op). */
  private holdsKey(
    provider: AiProvider,
    ciphertext: string,
    value: string,
  ): boolean {
    try {
      return (
        this.cipher.decrypt(ciphertext, aiProviderKeyContext(provider)) ===
        value
      );
    } catch {
      return false;
    }
  }

  private async toResponse(
    state: AiSettingsState,
  ): Promise<AiSettingsResponse> {
    const [updatedBy] = state.updatedById
      ? await this.db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, state.updatedById))
      : [];
    const providers = Object.fromEntries(
      AI_PROVIDERS.map((provider) => {
        const key = state.keys[provider];
        const model = state.models[provider];
        return [
          provider,
          {
            defaultModel: DEFAULT_AI_MODELS[provider],
            model: model.model,
            modelSource: model.source,
            baseUrlConfigured:
              aiBaseUrlFor(provider, state.neonBaseUrl) !== null,
            key: {
              configured: key.apiKey !== null,
              source: key.source,
              last4: key.last4,
              unreadable: key.unreadable,
              updatedAt: key.updatedAt?.toISOString() ?? null,
            },
          },
        ];
      }),
    ) as AiSettingsResponse['providers'];
    return {
      provider: state.provider,
      providerSource: state.providerSource,
      model: state.model,
      modelSource: state.modelSource,
      textImageModel: state.textImageModel.model,
      textImageModelSource: state.textImageModel.source,
      textImageEnabled: state.textImageEnabled,
      catalog: NEON_MODEL_CATALOG,
      configured: snapshotConfig(state) !== null,
      cipherConfigured: this.cipher.isConfigured,
      providers,
      updatedAt: state.updatedAt?.toISOString() ?? null,
      updatedBy: updatedBy ?? null,
    };
  }
}
