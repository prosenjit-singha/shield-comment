import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';

/** DI token for the configured bucket target (`null` when storage env vars are missing). */
export const STORAGE_TARGET = Symbol('STORAGE_TARGET');

export interface StorageTarget {
  client: S3Client;
  bucket: string;
}

/**
 * Builds the S3 client for Neon Object Storage from the env vars `neon deploy` pulls
 * (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`)
 * plus our `STORAGE_BUCKET`. Returns `null` unless all five are set, so local dev and
 * compose run without storage. Neon needs path-style addressing (`forcePathStyle`).
 */
export function createStorageTarget(
  config: ConfigService<EnvironmentVariables, true>,
): StorageTarget | null {
  const accessKeyId = config.get('AWS_ACCESS_KEY_ID', { infer: true });
  const secretAccessKey = config.get('AWS_SECRET_ACCESS_KEY', { infer: true });
  const endpoint = config.get('AWS_ENDPOINT_URL_S3', { infer: true });
  const region = config.get('AWS_REGION', { infer: true });
  const bucket = config.get('STORAGE_BUCKET', { infer: true });
  if (!accessKeyId || !secretAccessKey || !endpoint || !region || !bucket) {
    return null;
  }
  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  return { client, bucket };
}
