import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { AI_PROVIDERS, type AiProvider } from '../../ai-gateway/ai-provider.js';
import { users } from './auth.js';
import { id, timestamps, timestamptz } from './columns.js';

/** Longest model id accepted (admin settings, M5-T3). */
export const AI_MODEL_MAX_LENGTH = 100;

const providerList = AI_PROVIDERS.map((p) => `'${p}'`).join(', ');

/**
 * Platform-wide AI provider choice (M5-T3, decision D16). At most one row (`id = 1`), created by
 * the first `PATCH /api/admin/settings/ai` that sets a provider or model; no row = everything
 * from `.env`. `null` columns fall back per field: provider → `AI_PROVIDER` → `neon`;
 * model → `AI_GATEWAY_MODEL` (only for the env provider) → `DEFAULT_AI_MODELS`. `model` is the
 * **Text model**; `text_image_model` (→ `DEFAULT_TEXT_IMAGE_MODEL`) + `text_image_enabled` are the
 * Text + Image model and its switch (M5-T15b, D22/D23: stored only, image moderation is later).
 * Not tenant data: super admin only.
 */
export const aiProviderSettings = pgTable(
  'ai_provider_settings',
  {
    id: smallint().primaryKey().default(1),
    provider: text().$type<AiProvider>(),
    model: text(),
    textImageModel: text(),
    textImageEnabled: boolean().notNull().default(false),
    /** Super admin who saved last; `set null` so deleting a user never blocks on settings. */
    updatedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    check('ai_provider_settings_singleton', sql`${t.id} = 1`),
    check(
      'ai_provider_settings_provider_check',
      sql.raw(`provider is null or provider in (${providerList})`),
    ),
    check(
      'ai_provider_settings_model_length',
      sql.raw(
        `model is null or char_length(model) between 1 and ${AI_MODEL_MAX_LENGTH}`,
      ),
    ),
    check(
      'ai_provider_settings_text_image_model_length',
      sql.raw(
        `text_image_model is null or char_length(text_image_model) between 1 and ${AI_MODEL_MAX_LENGTH}`,
      ),
    ),
  ],
);

/**
 * Encrypted API key per provider (M5-T3, D16). `key_ciphertext` = `TokenCipherService` output with
 * context `aiProviderKeyContext(provider)` (`ai_provider_key:platform:<provider>`); `last4` is the
 * only part ever shown again. Clearing a key deletes the row (the `.env` key then applies).
 */
export const aiProviderKeys = pgTable(
  'ai_provider_keys',
  {
    provider: text().$type<AiProvider>().primaryKey(),
    keyCiphertext: text().notNull(),
    last4: text().notNull(),
    updatedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    check(
      'ai_provider_keys_provider_check',
      sql.raw(`provider in (${providerList})`),
    ),
    check(
      'ai_provider_keys_ciphertext_format',
      sql`${t.keyCiphertext} ~ '^v[0-9]+:'`,
    ),
    check('ai_provider_keys_last4_length', sql`char_length(${t.last4}) = 4`),
  ],
);

/** Audited fields: one row per changed field. */
export const AI_SETTINGS_AUDIT_FIELDS = [
  'provider',
  'model',
  'text_image_model',
  'text_image_enabled',
  ...AI_PROVIDERS.map((p) => `key.${p}` as const),
] as const;
export type AiSettingsAuditField = (typeof AI_SETTINGS_AUDIT_FIELDS)[number];

/** Key rows never hold a key: `before` = `set` | null (none in the DB), `after` = `set` | `cleared`. */
export const AI_KEY_AUDIT_VALUES = ['set', 'cleared'] as const;

/** Longest user agent kept (same cap as the plan audit). */
export const AI_SETTINGS_AUDIT_USER_AGENT_MAX = 512;

const keyFields = AI_PROVIDERS.map((p) => `'key.${p}'`).join(', ');

/**
 * AI settings change log (M5-T3, D16): who changed which field, before → after, from where.
 * `provider` / `model` / `text_image_model` store the DB values (`null` = `.env` / default
 * fallback); `text_image_enabled` stores `true` / `false`; key fields store
 * only `set` / `cleared` (never a key, last 4 or ciphertext). Written in the PATCH transaction;
 * rows are never updated. Actor FK `restrict` like the other audit tables (e2e `cleanup()` deletes
 * the actor's rows first).
 */
export const aiSettingsAuditLogs = pgTable(
  'ai_settings_audit_logs',
  {
    id: id(),
    adminId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    field: text().$type<AiSettingsAuditField>().notNull(),
    before: text(),
    after: text(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index('ai_settings_audit_logs_created_at_index').on(
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index().on(t.adminId),
    check(
      'ai_settings_audit_logs_field_check',
      sql.raw(
        `field in (${AI_SETTINGS_AUDIT_FIELDS.map((f) => `'${f}'`).join(', ')})`,
      ),
    ),
    check(
      'ai_settings_audit_logs_values_check',
      sql.raw(
        `case
          when field = 'provider' then (before is null or before in (${providerList})) and (after is null or after in (${providerList}))
          when field in ('model', 'text_image_model') then (before is null or char_length(before) between 1 and ${AI_MODEL_MAX_LENGTH}) and (after is null or char_length(after) between 1 and ${AI_MODEL_MAX_LENGTH})
          when field = 'text_image_enabled' then before in ('true', 'false') and after in ('true', 'false')
          when field in (${keyFields}) then (before is null or before = 'set') and after in ('set', 'cleared')
          else false
        end`,
      ),
    ),
    check(
      'ai_settings_audit_logs_ip_address_length',
      sql`ip_address is null or char_length(ip_address) between 1 and 45`,
    ),
    check(
      'ai_settings_audit_logs_user_agent_length',
      sql.raw(
        `user_agent is null or char_length(user_agent) between 1 and ${AI_SETTINGS_AUDIT_USER_AGENT_MAX}`,
      ),
    ),
  ],
);

export const aiSettingsAuditLogsRelations = relations(
  aiSettingsAuditLogs,
  ({ one }) => ({
    admin: one(users, {
      fields: [aiSettingsAuditLogs.adminId],
      references: [users.id],
    }),
  }),
);

/** Longest top-up note (M5-T15d, D26). */
export const AI_CREDIT_TOPUP_NOTE_MAX = 200;

/**
 * Neon AI credit top-ups entered by the super admin (M5-T15d, D26): Neon has no API for the AI
 * Gateway balance, so "remaining" = sum of these − our estimated spend. `topped_up_on` is an
 * Asia/Dhaka calendar date (not in the future: checked by the API, it needs the clock). A
 * mistaken entry is deleted (audited in `ai_credit_topup_audit_logs`). Creator FK `restrict` like
 * the audit tables (e2e `cleanup()` deletes the rows first). Not tenant data: super admin only.
 */
export const aiCreditTopups = pgTable(
  'ai_credit_topups',
  {
    id: id(),
    amountUsd: numeric({ precision: 10, scale: 2, mode: 'number' }).notNull(),
    toppedUpOn: date({ mode: 'string' }).notNull(),
    note: text(),
    createdById: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    index().on(t.createdById),
    check('ai_credit_topups_amount_positive', sql`${t.amountUsd} > 0`),
    check(
      'ai_credit_topups_note_length',
      sql.raw(
        `note is null or char_length(note) between 1 and ${AI_CREDIT_TOPUP_NOTE_MAX}`,
      ),
    ),
  ],
);

export const AI_CREDIT_TOPUP_AUDIT_ACTIONS = ['add', 'delete'] as const;
export type AiCreditTopupAuditAction =
  (typeof AI_CREDIT_TOPUP_AUDIT_ACTIONS)[number];

/**
 * Top-up change log (M5-T15d, D26): one row per add / delete with a copy of the top-up (the row
 * itself is gone after a delete, so `topup_id` has no FK). Written in the same transaction; never
 * updated.
 */
export const aiCreditTopupAuditLogs = pgTable(
  'ai_credit_topup_audit_logs',
  {
    id: id(),
    adminId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: text().$type<AiCreditTopupAuditAction>().notNull(),
    topupId: uuid().notNull(),
    amountUsd: numeric({ precision: 10, scale: 2, mode: 'number' }).notNull(),
    toppedUpOn: date({ mode: 'string' }).notNull(),
    note: text(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index().on(t.adminId),
    index().on(t.topupId),
    check(
      'ai_credit_topup_audit_logs_action_check',
      sql.raw(
        `action in (${AI_CREDIT_TOPUP_AUDIT_ACTIONS.map((a) => `'${a}'`).join(', ')})`,
      ),
    ),
    check(
      'ai_credit_topup_audit_logs_ip_address_length',
      sql`ip_address is null or char_length(ip_address) between 1 and 45`,
    ),
    check(
      'ai_credit_topup_audit_logs_user_agent_length',
      sql.raw(
        `user_agent is null or char_length(user_agent) between 1 and ${AI_SETTINGS_AUDIT_USER_AGENT_MAX}`,
      ),
    ),
  ],
);
