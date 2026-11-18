import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
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

  // --- Neon AI Gateway. Optional: AiGatewayService is disabled without them.
  /** Bare branch gateway host (no path), e.g. `https://<branch-id>-api.ai.<region>.aws.neon.tech`. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  NEON_AI_GATEWAY_BASE_URL?: string;

  @IsOptional()
  @IsString()
  NEON_AI_GATEWAY_TOKEN?: string;

  /** Default chat model (gateway catalog id). */
  @IsOptional()
  @IsString()
  AI_GATEWAY_MODEL?: string;

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
