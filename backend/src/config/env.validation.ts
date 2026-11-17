import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
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
