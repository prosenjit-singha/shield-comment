import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

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
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
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
    throw new Error(`Invalid environment configuration:\n${errors.toString()}`);
  }
  return validated;
}
