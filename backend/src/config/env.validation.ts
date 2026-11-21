import { plainToInstance, Type } from 'class-transformer';
import {
  isEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
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

  /**
   * Proxies in front of the backend that append to `X-Forwarded-For` (compose 1; Fly.io 1 as the
   * fallback of `TRUST_FLY_CLIENT_IP`). 0 = socket address only. See `src/common/http/client-ip.ts`.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS = 0;

  /**
   * Fly.io only (M9-T14a): take the client IP from `Fly-Client-IP` (set by Fly's edge, a client-sent
   * one is overwritten); falls back to `TRUST_PROXY_HOPS`. Never `true` without Fly's edge in front.
   */
  @IsIn(['true', 'false'], {
    message: 'TRUST_FLY_CLIENT_IP must be true or false',
  })
  TRUST_FLY_CLIENT_IP: 'true' | 'false' = 'false';

  /** Signs Better Auth cookies/tokens. Generate with `openssl rand -base64 48`. */
  @IsString()
  @MinLength(32)
  BETTER_AUTH_SECRET!: string;

  /** Public URL of this backend, without `/api/auth` (e.g. `http://localhost:3000`). */
  @IsString()
  BETTER_AUTH_URL!: string;

  /**
   * Comma list of app origins allowed to call `/api/auth/*` (CSRF / redirect checks). Required in
   * production, https only there (except localhost hosts): see `productionOriginErrors()`.
   */
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

  // --- Transactional email (Resend HTTP API, M7-T1, Module 7 D6). Optional; set both or neither.
  // Unset: outside production emails are logged (to, subject); in production sends fail (logged at boot).
  /** Resend API key (`re_…`, "Sending access" is enough). */
  @ValidateIf((env: EnvironmentVariables) => hasEmailEnv(env))
  @Matches(/^re_\S{8,}$/, {
    message:
      'RESEND_API_KEY must be a Resend API key (re_…) (set together with EMAIL_FROM)',
  })
  RESEND_API_KEY?: string;

  /** Sender on a domain verified in Resend: `alerts@example.com` or `ShieldComment <alerts@example.com>`. */
  @ValidateIf((env: EnvironmentVariables) => hasEmailEnv(env))
  @ValidateBy({
    name: 'isEmailFrom',
    validator: {
      validate: isEmailFrom,
      defaultMessage: () =>
        'EMAIL_FROM must be an email address or "Name <address>" (set together with RESEND_API_KEY)',
    },
  })
  EMAIL_FROM?: string;

  // --- Telegram alert bot (M7-T8, Module 7 D13). Optional; set all three or none (unset = the
  // link route answers 503 and the webhook 503). Register the webhook once with `setWebhook`
  // (url = <backend>/api/telegram/webhook, secret_token = TELEGRAM_WEBHOOK_SECRET).
  /** BotFather token `<bot id>:<secret>`. */
  @ValidateIf((env: EnvironmentVariables) => hasTelegramEnv(env))
  @Matches(/^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/, {
    message:
      'TELEGRAM_BOT_TOKEN must be a BotFather token <id>:<secret> (set together with TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET)',
  })
  TELEGRAM_BOT_TOKEN?: string;

  /** The bot's username without `@` (ends in "bot"); builds the `t.me/<bot>?start=<code>` links. */
  @ValidateIf((env: EnvironmentVariables) => hasTelegramEnv(env))
  @Matches(/^[A-Za-z][A-Za-z0-9_]{1,29}bot$/i, {
    message:
      'TELEGRAM_BOT_USERNAME must be the bot username without @, ending in "bot" (set together with the other TELEGRAM_* vars)',
  })
  TELEGRAM_BOT_USERNAME?: string;

  /** `setWebhook` secret_token: Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`. 16-256 of A-Z a-z 0-9 _ -. */
  @ValidateIf((env: EnvironmentVariables) => hasTelegramEnv(env))
  @Matches(/^[A-Za-z0-9_-]{16,256}$/, {
    message:
      'TELEGRAM_WEBHOOK_SECRET must be 16-256 characters of A-Z a-z 0-9 _ - (set together with the other TELEGRAM_* vars)',
  })
  TELEGRAM_WEBHOOK_SECRET?: string;

  /** Test/compose-only Bot API host (a stub). Unset = `https://api.telegram.org`. Refused when `NODE_ENV=production`. */
  @IsOptional()
  @IsUrl(
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'TELEGRAM_API_BASE_URL must be an absolute http(s) URL' },
  )
  @NotInProduction('TELEGRAM_API_BASE_URL')
  TELEGRAM_API_BASE_URL?: string;

  // --- SSLCommerz V4 payments (Module 8 D1). Optional: unset → checkout answers 503
  // PAYMENTS_NOT_CONFIGURED. Store id + password both or neither. Sandbox by default; production
  // with sandbox on logs a startup warning.
  /** SSLCommerz store id (sandbox: from developer.sslcommerz.com registration). */
  @ValidateIf((env: EnvironmentVariables) => hasSslcommerzEnv(env))
  @Matches(/^[A-Za-z0-9_-]{3,64}$/, {
    message:
      'SSLCOMMERZ_STORE_ID must be the SSLCommerz store id (set together with SSLCOMMERZ_STORE_PASSWORD)',
  })
  SSLCOMMERZ_STORE_ID?: string;

  /** Store password (API key), server-side only. */
  @ValidateIf((env: EnvironmentVariables) => hasSslcommerzEnv(env))
  @Matches(/^\S{3,128}$/, {
    message:
      'SSLCOMMERZ_STORE_PASSWORD must be the store password, no spaces (set together with SSLCOMMERZ_STORE_ID)',
  })
  SSLCOMMERZ_STORE_PASSWORD?: string;

  /** `true` (default) = sandbox.sslcommerz.com, `false` = securepay.sslcommerz.com (live). */
  @IsIn(['true', 'false'], {
    message: 'SSLCOMMERZ_SANDBOX must be true or false',
  })
  SSLCOMMERZ_SANDBOX: 'true' | 'false' = 'true';

  /**
   * M8-T6b (D4): tokenized auto-renew. `false` (default) = manual renewal only; turn on only once
   * SSLCommerz approved tokenization for the store (needs the token cipher env too).
   */
  @IsIn(['true', 'false'], {
    message: 'SSLCOMMERZ_TOKENIZATION must be true or false',
  })
  SSLCOMMERZ_TOKENIZATION: 'true' | 'false' = 'false';

  /** Test/compose-only SSLCommerz host (a stub). Refused when `NODE_ENV=production`. */
  @IsOptional()
  @IsUrl(
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'SSLCOMMERZ_BASE_URL must be an absolute http(s) URL' },
  )
  @NotInProduction('SSLCOMMERZ_BASE_URL')
  SSLCOMMERZ_BASE_URL?: string;

  // --- Invoice seller details (M8-T7, Module 8 D8). Optional: unset → `null` on invoices.
  @IsOptional()
  @IsString()
  @Length(1, 200)
  INVOICE_SELLER_NAME?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  INVOICE_SELLER_ADDRESS?: string;

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
  @NotInProduction('META_GRAPH_BASE_URL')
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

/** Test-only env overrides (stub hosts): boot fails when set with `NODE_ENV=production`. */
function NotInProduction(name: string): PropertyDecorator {
  return ValidateBy({
    name: 'isNotProduction',
    validator: {
      validate: (_value: unknown, args) =>
        (args?.object as EnvironmentVariables | undefined)?.NODE_ENV !==
        NodeEnv.Production,
      defaultMessage: () =>
        `${name} is a test-only override and must not be set when NODE_ENV=production`,
    },
  });
}

function hasSslcommerzEnv(env: EnvironmentVariables): boolean {
  return (
    env.SSLCOMMERZ_STORE_ID !== undefined ||
    env.SSLCOMMERZ_STORE_PASSWORD !== undefined
  );
}

function hasMetaAppEnv(env: EnvironmentVariables): boolean {
  return (
    env.META_APP_ID !== undefined ||
    env.META_APP_SECRET !== undefined ||
    env.META_LOGIN_CONFIG_ID !== undefined ||
    env.META_OAUTH_REDIRECT_URI !== undefined
  );
}

function hasTelegramEnv(env: EnvironmentVariables): boolean {
  return (
    env.TELEGRAM_BOT_TOKEN !== undefined ||
    env.TELEGRAM_BOT_USERNAME !== undefined ||
    env.TELEGRAM_WEBHOOK_SECRET !== undefined
  );
}

function hasEmailEnv(env: EnvironmentVariables): boolean {
  return env.RESEND_API_KEY !== undefined || env.EMAIL_FROM !== undefined;
}

/** `address@domain` or `Name <address@domain>`. */
function isEmailFrom(value: unknown): boolean {
  return isEmail(value, { allow_display_name: true });
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

function splitOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/** https, or http on `localhost` / `*.localhost` (compose; browsers treat those as secure). */
function isSecureOrLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname.endsWith('.localhost'))
    );
  } catch {
    return false;
  }
}

/**
 * Production-only origin rules (M9-T3, Module 9 D3): `TRUSTED_ORIGINS` is required, and every origin
 * or public URL is https unless its host is `localhost` / `*.localhost`. Dev/test are not checked.
 */
function productionOriginErrors(env: EnvironmentVariables): string[] {
  if (env.NODE_ENV !== NodeEnv.Production) return [];
  const rule =
    'must use https:// when NODE_ENV=production (http only for localhost / *.localhost)';
  const errors: string[] = [];
  const trusted = splitOrigins(env.TRUSTED_ORIGINS);
  if (trusted.length === 0) {
    errors.push(
      '- TRUSTED_ORIGINS: is required when NODE_ENV=production (comma list of the app origins)',
    );
  }
  const lists: [string, string[]][] = [
    ['TRUSTED_ORIGINS', trusted],
    ['CORS_ORIGINS', splitOrigins(env.CORS_ORIGINS)],
  ];
  for (const [name, origins] of lists) {
    origins.forEach((origin, i) => {
      if (!isSecureOrLocalUrl(origin)) {
        errors.push(`- ${name}: entry ${i + 1} ${rule}`);
      }
    });
  }
  const urls: [string, string | undefined][] = [
    ['BETTER_AUTH_URL', env.BETTER_AUTH_URL],
    ['CLIENT_APP_URL', env.CLIENT_APP_URL],
  ];
  for (const [name, value] of urls) {
    if (value !== undefined && !isSecureOrLocalUrl(value)) {
      errors.push(`- ${name}: ${rule}`);
    }
  }
  return errors;
}

/** Fails fast at boot if required env vars are missing or malformed. */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  // Property + constraint messages only: messages never include values (no secrets in logs).
  const details = [
    ...validateSync(validated, { skipMissingProperties: false }).map(
      (error) =>
        `- ${error.property}: ${Object.values(error.constraints ?? {}).join('; ')}`,
    ),
    ...productionOriginErrors(validated),
  ];
  if (details.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${details.join('\n')}`,
    );
  }
  return validated;
}
