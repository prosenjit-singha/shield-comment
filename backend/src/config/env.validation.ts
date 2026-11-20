import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  validateSync,
} from 'class-validator';
import { AI_PROVIDERS, type AiProvider } from '../ai-gateway/ai-provider.js';
import { parseModelPrices } from '../moderation/ai-model-prices.js';
import {
  AES_256_KEY_BYTES,
  decodeAes256Key,
  isValidTokenKeyId,
  parsePreviousTokenKeys,
  TOKEN_KEY_ID_PATTERN,
} from '../crypto/token-keyring.js';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  LOG_LEVEL = 'info';

  /** Runtime connection. Prod: Neon **pooled** URL (host has `-pooler`). */
  @IsString()
  DATABASE_URL!: string;

  /** Neon **direct** URL, used only for migrations (drizzle-kit + `db:deploy`). Defaults to `DATABASE_URL`. */
  @IsOptional()
  @IsString()
  DIRECT_URL?: string;

  @IsString()
  REDIS_URL!: string;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /** Signs Better Auth cookies/tokens. Generate with `openssl rand -base64 48`. */
  @IsString()
  @MinLength(32)
  BETTER_AUTH_SECRET!: string;

  /** Public URL of this backend, without `/api/auth` (e.g. `http://localhost:3000`). */
  @IsString()
  BETTER_AUTH_URL!: string;

  /** Comma list of app origins allowed to call `/api/auth/*` (CSRF / redirect checks). */
  @IsOptional()
  @IsString()
  TRUSTED_ORIGINS?: string;

  /**
   * Public origin of the client app (`client/`), used for impersonation `redirectUrl`s
   * (`<origin>/impersonate?token=…`). Defaults to the dev URL `http://app.localhost:5174`.
   */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  CLIENT_APP_URL?: string;

  // --- Neon Object Storage (S3-compatible). Optional: StorageService is disabled without them.
  // `neon deploy` / `neon env pull` writes the AWS_* names; STORAGE_BUCKET is the bucket key in neon.ts.
  @IsOptional()
  @IsString()
  AWS_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  AWS_SECRET_ACCESS_KEY?: string;

  /** Branch S3 endpoint, e.g. `https://<branch-id>.storage.<region>.aws.neon.tech`. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  AWS_ENDPOINT_URL_S3?: string;

  @IsOptional()
  @IsString()
  AWS_REGION?: string;

  @IsOptional()
  @IsString()
  STORAGE_BUCKET?: string;

  // --- LLM provider (M5-T1, decisions D1/D16). Optional: AiGatewayService reports "not
  // configured" when the active provider has no key. M5-T3 moves the choice to /admin/settings
  // (keys encrypted in the DB); these values stay as the fallback.
  /** Active provider: `neon` (default) | `openai` | `anthropic` | `google`. */
  @IsOptional()
  @IsIn(AI_PROVIDERS)
  AI_PROVIDER?: AiProvider;

  /** Bare branch gateway host (no path), e.g. `https://<branch-id>-api.ai.<region>.aws.neon.tech`. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  NEON_AI_GATEWAY_BASE_URL?: string;

  @IsOptional()
  @IsString()
  NEON_AI_GATEWAY_TOKEN?: string;

  /** OpenAI API key (`AI_PROVIDER=openai`). */
  @IsOptional()
  @IsString()
  OPENAI_API_KEY?: string;

  /** Google AI Studio (Gemini) API key (`AI_PROVIDER=google`). */
  @IsOptional()
  @IsString()
  GEMINI_API_KEY?: string;

  /** Anthropic API key (`AI_PROVIDER=anthropic`, native Messages API). */
  @IsOptional()
  @IsString()
  ANTHROPIC_API_KEY?: string;

  /** Chat model of the active provider. Defaults per provider (`DEFAULT_AI_MODELS`). */
  @IsOptional()
  @IsString()
  AI_GATEWAY_MODEL?: string;

  // --- Moderation worker (M5-T12): `comment-moderation` concurrency + BullMQ limiter (≈ LLM calls).
  /** Jobs one API process works on at the same time. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  MODERATION_WORKER_CONCURRENCY = 4;

  /** At most this many moderation jobs start per `MODERATION_LLM_RATE_DURATION_MS` (all processes). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  MODERATION_LLM_RATE_MAX = 10;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(3_600_000)
  MODERATION_LLM_RATE_DURATION_MS = 1000;

  // --- Admin AI usage estimate (M5-T13, D14): `/admin/system/health` `ai` cost USD + BDT.
  /** BDT per 1 USD for the estimated AI cost in BDT (default 122). */
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 })
  @Min(1)
  @Max(1000)
  AI_COST_USD_TO_BDT = 122;

  /**
   * Adds to / replaces the built-in price table (USD per 1M tokens), comma-separated
   * `provider:model=input/output`, e.g. `neon:gpt-oss-20b=0.05/0.2`. Unknown model = cost `null`.
   */
  @IsOptional()
  @ValidateBy({
    name: 'isModelPriceList',
    validator: {
      validate: (value: unknown) => modelPricesError(value) === null,
      defaultMessage: (args) =>
        `AI_MODEL_PRICES: ${modelPricesError(args?.value) ?? 'invalid'}`,
    },
  })
  AI_MODEL_PRICES?: string;

  // --- Token cipher (AES-256-GCM for Meta access tokens at rest, M3-T1, decision D2).
  // Optional: TokenCipherService is disabled when all three are unset. KEY + KEY_ID go together.
  /** Base64 of exactly 32 bytes: `openssl rand -base64 32`. Encrypts new tokens. */
  @ValidateIf((env: EnvironmentVariables) => hasTokenCipherEnv(env))
  @ValidateBy({
    name: 'isAes256Key',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && decodeAes256Key(value) !== null,
      defaultMessage: () =>
        `TOKEN_ENCRYPTION_KEY must be base64 of exactly ${AES_256_KEY_BYTES} bytes (set together with TOKEN_ENCRYPTION_KEY_ID)`,
    },
  })
  TOKEN_ENCRYPTION_KEY?: string;

  /** Id of the current key, stored in every ciphertext (`v1:<keyId>:…`), e.g. `k2026a`. */
  @ValidateIf((env: EnvironmentVariables) => hasTokenCipherEnv(env))
  @ValidateBy({
    name: 'isTokenKeyId',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && isValidTokenKeyId(value),
      defaultMessage: () =>
        `TOKEN_ENCRYPTION_KEY_ID must match ${TOKEN_KEY_ID_PATTERN} (set together with TOKEN_ENCRYPTION_KEY)`,
    },
  })
  TOKEN_ENCRYPTION_KEY_ID?: string;

  /** Old keys, decrypt only: `id:base64,id:base64`. Ids unique and not the current id. */
  @IsOptional()
  @ValidateBy({
    name: 'isPreviousTokenKeys',
    validator: {
      validate: (value: unknown, args) =>
        previousTokenKeysError(value, args?.object) === null,
      defaultMessage: (args) =>
        `TOKEN_ENCRYPTION_PREVIOUS_KEYS: ${previousTokenKeysError(args?.value, args?.object) ?? 'invalid'}`,
    },
  })
  TOKEN_ENCRYPTION_PREVIOUS_KEYS?: string;

  // --- Meta app (Facebook Login for Business + Graph API, M3-T3, decisions D1/D9).
  // Optional: MetaGraphClient is disabled when all four are unset; set all four together.
  // Local/staging use the Meta *test app*, production the live app (D1).
  /** Numeric Meta app id. */
  @ValidateIf((env: EnvironmentVariables) => hasMetaAppEnv(env))
  @Matches(/^[0-9]{1,32}$/, {
    message:
      'META_APP_ID must be the numeric Meta app id (set together with the other META_* app vars)',
  })
  META_APP_ID?: string;

  /** App secret: server-side only, signs `appsecret_proof` on every token call. */
  @ValidateIf((env: EnvironmentVariables) => hasMetaAppEnv(env))
  @IsString({
    message: 'META_APP_SECRET is required with the other META_* app vars',
  })
  @MinLength(16, { message: 'META_APP_SECRET looks too short' })
  META_APP_SECRET?: string;

  /** Facebook Login for Business configuration id (user access token config, scopes per D4). */
  @ValidateIf((env: EnvironmentVariables) => hasMetaAppEnv(env))
  @Matches(/^[0-9]{1,32}$/, {
    message:
      'META_LOGIN_CONFIG_ID must be the numeric Login for Business config id (set together with the other META_* app vars)',
  })
  META_LOGIN_CONFIG_ID?: string;

  /** Full OAuth callback URL, exactly as allow-listed in the Meta app (host per D6). */
  @ValidateIf((env: EnvironmentVariables) => hasMetaAppEnv(env))
  @IsUrl(
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    {
      message:
        'META_OAUTH_REDIRECT_URI must be an absolute http(s) URL (set together with the other META_* app vars)',
    },
  )
  META_OAUTH_REDIRECT_URI?: string;

  /** Overrides the pinned Graph API version (`DEFAULT_GRAPH_API_VERSION`), e.g. `v27.0`. */
  @IsOptional()
  @Matches(/^v[0-9]{1,3}\.[0-9]$/, {
    message: 'META_GRAPH_API_VERSION must look like v26.0',
  })
  META_GRAPH_API_VERSION?: string;

  /**
   * Test/compose-only Graph host (Module 6 D17): the gate's Playwright run points the backend at a
   * Graph stub. Unset = `https://graph.facebook.com`. Refused when `NODE_ENV=production`.
   */
  @IsOptional()
  @IsUrl(
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'META_GRAPH_BASE_URL must be an absolute http(s) URL' },
  )
  @ValidateBy({
    name: 'isNotProduction',
    validator: {
      validate: (_value: unknown, args) =>
        (args?.object as EnvironmentVariables | undefined)?.NODE_ENV !==
        NodeEnv.Production,
      defaultMessage: () =>
        'META_GRAPH_BASE_URL is a test-only override and must not be set when NODE_ENV=production',
    },
  })
  META_GRAPH_BASE_URL?: string;

  /**
   * Meta webhook subscription handshake (`GET /api/webhooks/meta`, Module 4 D1): Meta echoes it as
   * `hub.verify_token`. Optional and independent of the app group: unset → the handshake answers 503.
   * 16–256 printable ASCII characters, no spaces (`openssl rand -hex 24`).
   */
  @IsOptional()
  @Matches(/^[!-~]{16,256}$/, {
    message:
      'META_WEBHOOK_VERIFY_TOKEN must be 16-256 printable ASCII characters without spaces',
  })
  META_WEBHOOK_VERIFY_TOKEN?: string;
}

function hasMetaAppEnv(env: EnvironmentVariables): boolean {
  return (
    env.META_APP_ID !== undefined ||
    env.META_APP_SECRET !== undefined ||
    env.META_LOGIN_CONFIG_ID !== undefined ||
    env.META_OAUTH_REDIRECT_URI !== undefined
  );
}

function hasTokenCipherEnv(env: EnvironmentVariables): boolean {
  return (
    env.TOKEN_ENCRYPTION_KEY !== undefined ||
    env.TOKEN_ENCRYPTION_KEY_ID !== undefined ||
    env.TOKEN_ENCRYPTION_PREVIOUS_KEYS !== undefined
  );
}

/** `null` when valid, else why `AI_MODEL_PRICES` can't be parsed. */
function modelPricesError(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string';
  try {
    parseModelPrices(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid';
  }
}

/** `null` when valid; the message never contains key material. */
function previousTokenKeysError(
  value: unknown,
  env: object | undefined,
): string | null {
  if (typeof value !== 'string') return 'must be a string';
  try {
    const keys = parsePreviousTokenKeys(value);
    const currentId = (env as EnvironmentVariables | undefined)
      ?.TOKEN_ENCRYPTION_KEY_ID;
    if (currentId !== undefined && keys.some((k) => k.id === currentId)) {
      return `must not reuse the current key id "${currentId}"`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid';
  }
}

/** Fails fast at boot if required env vars are missing or malformed. */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    // Property + constraint messages only: messages never include values (no secrets in logs).
    const details = errors
      .map(
        (error) =>
          `- ${error.property}: ${Object.values(error.constraints ?? {}).join('; ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return validated;
}
