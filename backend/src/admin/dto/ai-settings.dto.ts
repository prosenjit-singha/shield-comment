import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { AiConnectionTestResult } from '../../ai-gateway/ai-gateway.service.js';
import { AI_PROVIDERS, type AiProvider } from '../../ai-gateway/ai-provider.js';
import type {
  AiKeySource,
  AiSettingSource,
} from '../../ai-gateway/ai-settings.rules.js';
import {
  AI_MODEL_MAX_LENGTH,
  type AiSettingsAuditField,
} from '../../db/schema/index.js';

export const AI_KEY_MIN_LENGTH = 8;
export const AI_KEY_MAX_LENGTH = 500;
export const AI_SETTINGS_AUDIT_PAGE_MAX = 100;

/** Model id: 1–100 printable ASCII characters, no spaces (after trimming). */
export const AI_MODEL_PATTERN = new RegExp(
  `^[\\x21-\\x7E]{1,${AI_MODEL_MAX_LENGTH}}$`,
);
/** API key: 8–500 printable ASCII characters, no spaces (after trimming). */
export const AI_KEY_PATTERN = new RegExp(
  `^[\\x21-\\x7E]{${AI_KEY_MIN_LENGTH},${AI_KEY_MAX_LENGTH}}$`,
);

const MODEL_MESSAGE = `model must be 1–${AI_MODEL_MAX_LENGTH} printable characters without spaces`;
const KEY_MESSAGE = `$property must be ${AI_KEY_MIN_LENGTH}–${AI_KEY_MAX_LENGTH} printable characters without spaces`;

const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

/** Present-but-`null` fails the validators that follow (only "absent" skips them). */
const unlessAbsent = <T extends object>(key: keyof T) =>
  ValidateIf((o: T) => o[key] !== undefined);

/** A key per provider: a string saves (replaces) it, `null` clears the DB key, absent = unchanged. */
export class AiKeysPatchDto {
  @trim
  @IsOptional()
  @IsString()
  @Matches(AI_KEY_PATTERN, { message: KEY_MESSAGE })
  neon?: string | null;

  @trim
  @IsOptional()
  @IsString()
  @Matches(AI_KEY_PATTERN, { message: KEY_MESSAGE })
  openai?: string | null;

  @trim
  @IsOptional()
  @IsString()
  @Matches(AI_KEY_PATTERN, { message: KEY_MESSAGE })
  anthropic?: string | null;

  @trim
  @IsOptional()
  @IsString()
  @Matches(AI_KEY_PATTERN, { message: KEY_MESSAGE })
  google?: string | null;
}

/**
 * `PATCH /api/admin/settings/ai` (M5-T3). All fields optional, at least one required.
 * `provider` changing without `model` resets the model to that provider's env/default model.
 * `model: null` clears the DB model (env/default applies).
 */
export class UpdateAiSettingsDto {
  @unlessAbsent<UpdateAiSettingsDto>('provider')
  @IsIn(AI_PROVIDERS)
  provider?: AiProvider;

  @trim
  @IsOptional()
  @IsString()
  @Matches(AI_MODEL_PATTERN, { message: MODEL_MESSAGE })
  model?: string | null;

  @unlessAbsent<UpdateAiSettingsDto>('keys')
  @IsObject()
  @ValidateNested()
  @Type(() => AiKeysPatchDto)
  keys?: AiKeysPatchDto;
}

/**
 * `POST /api/admin/settings/ai/test` (M5-T3): optional draft merged over the saved config.
 * No body (or `{}`) tests the saved config.
 */
export class TestAiConnectionDto {
  @unlessAbsent<TestAiConnectionDto>('provider')
  @IsIn(AI_PROVIDERS)
  provider?: AiProvider;

  @trim
  @unlessAbsent<TestAiConnectionDto>('model')
  @IsString()
  @Matches(AI_MODEL_PATTERN, { message: MODEL_MESSAGE })
  model?: string;

  @trim
  @unlessAbsent<TestAiConnectionDto>('apiKey')
  @IsString()
  @Matches(AI_KEY_PATTERN, { message: KEY_MESSAGE })
  apiKey?: string;
}

/** `GET /api/admin/settings/ai/audit`: `skip` ≥ 0 (default 0), `take` 1–100 (default 50). */
export class ListAiSettingsAuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AI_SETTINGS_AUDIT_PAGE_MAX)
  take: number = 50;
}

/** Key status of one provider. Never the key itself. */
export interface AiKeyStatus {
  /** A usable key exists (DB or `.env`). */
  configured: boolean;
  source: AiKeySource;
  /** Last 4 characters of the key in use, `null` when none. */
  last4: string | null;
  /** A DB key exists but can't be decrypted (cipher unset / key rotated away): treated as unset. */
  unreadable: boolean;
  /** When the DB key was saved, `null` = no DB key. */
  updatedAt: string | null;
}

export interface AiProviderStatus {
  defaultModel: string;
  /** Model used when this provider is the active one, and where it comes from. */
  model: string;
  modelSource: AiSettingSource;
  /** Neon needs `NEON_AI_GATEWAY_BASE_URL` (env only); the direct providers are always `true`. */
  baseUrlConfigured: boolean;
  key: AiKeyStatus;
}

/** `GET`/`PATCH /api/admin/settings/ai` response. */
export interface AiSettingsResponse {
  provider: AiProvider;
  providerSource: AiSettingSource;
  model: string;
  modelSource: AiSettingSource;
  /** The active provider has a key (and Neon a base URL): calls can be attempted. */
  configured: boolean;
  /** Keys can be saved (`TOKEN_ENCRYPTION_KEY` set); else a key save answers 503. */
  cipherConfigured: boolean;
  providers: Record<AiProvider, AiProviderStatus>;
  /** Last save of provider/model (`null` = never saved: all from `.env`/defaults). */
  updatedAt: string | null;
  updatedBy: { id: string; name: string; email: string } | null;
}

/** `POST /api/admin/settings/ai/test` response = the probe result (never a key). */
export type AiConnectionTestResponse = AiConnectionTestResult;

/**
 * One changed field. `provider`/`model`: DB values (`null` = `.env`/default fallback);
 * `key.<provider>`: `before` `set` | `null`, `after` `set` | `cleared`.
 */
export interface AiSettingsAuditEntry {
  id: string;
  field: AiSettingsAuditField;
  before: string | null;
  after: string | null;
  admin: { id: string; name: string; email: string };
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AiSettingsAuditList {
  items: AiSettingsAuditEntry[];
  total: number;
  skip: number;
  take: number;
}
