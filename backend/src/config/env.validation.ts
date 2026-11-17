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

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  REDIS_URL!: string;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /** HS256 secret for access tokens. Generate with `openssl rand -base64 48`. */
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  /** Separate HS256 secret for refresh tokens, so one can't be used as the other. */
  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET!: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL_SECONDS = 900;

  @Type(() => Number)
  @IsInt()
  @Min(300)
  JWT_REFRESH_TTL_SECONDS = 604_800;
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
