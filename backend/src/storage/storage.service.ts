import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { STORAGE_TARGET, type StorageTarget } from './storage.config.js';

export class StorageNotConfiguredError extends Error {
  constructor() {
    super(
      'Object storage is not configured (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION, STORAGE_BUCKET)',
    );
    this.name = 'StorageNotConfiguredError';
  }
}

export interface PutObjectOptions {
  contentType?: string;
  cacheControl?: string;
}

export interface StoredObject {
  body: Uint8Array;
  contentType?: string;
}

/** Default lifetime of presigned URLs (15 min). */
export const DEFAULT_PRESIGN_SECONDS = 900;
/** S3 caps SigV4 presigned URLs at 7 days. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

/** Object keys: 1–1024 chars, no leading `/`, no `..` segments. Store the key (not bytes) in Postgres. */
export function assertValidKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.split('/').includes('..')
  ) {
    throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
  }
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata?.httpStatusCode;
  return (
    error.name === 'NoSuchKey' || error.name === 'NotFound' || status === 404
  );
}

/**
 * Neon Object Storage (S3-compatible, branch-scoped) for one bucket.
 * Every method throws `StorageNotConfiguredError` when the env vars are missing.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(STORAGE_TARGET) private readonly target: StorageTarget | null,
  ) {}

  get enabled(): boolean {
    return this.target !== null;
  }

  get bucket(): string {
    return this.requireTarget().bucket;
  }

  async put(
    key: string,
    body: Uint8Array | string,
    options: PutObjectOptions = {},
  ): Promise<void> {
    assertValidKey(key);
    const { client, bucket } = this.requireTarget();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        CacheControl: options.cacheControl,
      }),
    );
    this.logger.debug(`object stored: ${key}`);
  }

  /** Returns `null` when the object doesn't exist. */
  async get(key: string): Promise<StoredObject | null> {
    assertValidKey(key);
    const { client, bucket } = this.requireTarget();
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const body = res.Body
        ? await res.Body.transformToByteArray()
        : new Uint8Array();
      return { body, contentType: res.ContentType };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Idempotent: deleting a missing key succeeds. */
  async delete(key: string): Promise<void> {
    assertValidKey(key);
    const { client, bucket } = this.requireTarget();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    this.logger.debug(`object deleted: ${key}`);
  }

  /** Presigned GET URL, so a browser can read a private object without credentials. */
  async presignGet(
    key: string,
    expiresInSeconds = DEFAULT_PRESIGN_SECONDS,
  ): Promise<string> {
    assertValidKey(key);
    const { client, bucket } = this.requireTarget();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: clampExpiry(expiresInSeconds) },
    );
  }

  /** Presigned PUT URL for direct browser uploads; the uploader must send the same Content-Type. */
  async presignPut(
    key: string,
    contentType: string,
    expiresInSeconds = DEFAULT_PRESIGN_SECONDS,
  ): Promise<string> {
    assertValidKey(key);
    const { client, bucket } = this.requireTarget();
    return getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: clampExpiry(expiresInSeconds) },
    );
  }

  onModuleDestroy(): void {
    this.target?.client.destroy();
  }

  private requireTarget(): StorageTarget {
    if (!this.target) throw new StorageNotConfiguredError();
    return this.target;
  }
}

function clampExpiry(seconds: number): number {
  return Math.min(Math.max(Math.floor(seconds), 1), MAX_PRESIGN_SECONDS);
}
