import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { createStorageTarget, type StorageTarget } from './storage.config.js';
import {
  assertValidKey,
  StorageNotConfiguredError,
  StorageService,
} from './storage.service.js';

const getSignedUrl = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }));

function makeService(send: (cmd: unknown) => Promise<unknown>) {
  const client = { send: vi.fn(send), destroy: vi.fn() };
  const target: StorageTarget = {
    client: client as unknown as S3Client,
    bucket: 'assets',
  };
  return { service: new StorageService(target), client };
}

function fakeConfig(values: Partial<EnvironmentVariables>) {
  return {
    get: (key: keyof EnvironmentVariables) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
}

describe('StorageService', () => {
  beforeEach(() => getSignedUrl.mockReset());

  it('puts an object into the bucket with its content type', async () => {
    const { service, client } = makeService(async () => ({}));
    await service.put('a/b.txt', 'hi', { contentType: 'text/plain' });
    const cmd = client.send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect((cmd as PutObjectCommand).input).toMatchObject({
      Bucket: 'assets',
      Key: 'a/b.txt',
      Body: 'hi',
      ContentType: 'text/plain',
    });
  });

  it('gets an object as bytes', async () => {
    const { service, client } = makeService(async () => ({
      Body: {
        transformToByteArray: async () => new TextEncoder().encode('hello'),
      },
      ContentType: 'text/plain',
    }));
    const obj = await service.get('k.txt');
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(new TextDecoder().decode(obj?.body)).toBe('hello');
    expect(obj?.contentType).toBe('text/plain');
  });

  it('returns null for a missing object', async () => {
    const notFound = Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    const { service } = makeService(async () => Promise.reject(notFound));
    await expect(service.get('nope.txt')).resolves.toBeNull();
  });

  it('rethrows other errors from get', async () => {
    const denied = Object.assign(new Error('denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const { service } = makeService(async () => Promise.reject(denied));
    await expect(service.get('k.txt')).rejects.toThrow('denied');
  });

  it('deletes an object', async () => {
    const { service, client } = makeService(async () => ({}));
    await service.delete('k.txt');
    const cmd = client.send.mock.calls[0][0] as DeleteObjectCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'assets', Key: 'k.txt' });
  });

  it('presigns GET and PUT with a clamped expiry', async () => {
    getSignedUrl.mockResolvedValue('https://signed');
    const { service } = makeService(async () => ({}));
    await expect(service.presignGet('k.txt', 60)).resolves.toBe(
      'https://signed',
    );
    expect(getSignedUrl.mock.calls[0][1]).toBeInstanceOf(GetObjectCommand);
    expect(getSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 60 });

    await service.presignPut('k.png', 'image/png', 10 ** 9);
    const put = getSignedUrl.mock.calls[1][1] as PutObjectCommand;
    expect(put.input.ContentType).toBe('image/png');
    expect(getSignedUrl.mock.calls[1][2]).toEqual({ expiresIn: 604800 });
  });

  it('rejects unsafe keys before calling S3', async () => {
    const { service, client } = makeService(async () => ({}));
    await expect(service.put('/abs', 'x')).rejects.toThrow(
      'Invalid object key',
    );
    expect(() => assertValidKey('a/../b')).toThrow();
    expect(() => assertValidKey('')).toThrow();
    expect(() => assertValidKey('workspaces/1/a.png')).not.toThrow();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('throws StorageNotConfiguredError when disabled', async () => {
    const service = new StorageService(null);
    expect(service.enabled).toBe(false);
    await expect(service.get('k')).rejects.toBeInstanceOf(
      StorageNotConfiguredError,
    );
  });

  it('destroys the client on shutdown', () => {
    const { service, client } = makeService(async () => ({}));
    service.onModuleDestroy();
    expect(client.destroy).toHaveBeenCalled();
  });
});

describe('createStorageTarget', () => {
  const full: Partial<EnvironmentVariables> = {
    AWS_ACCESS_KEY_ID: 'id',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_ENDPOINT_URL_S3: 'https://br-x.storage.c-1.us-east-2.aws.neon.tech',
    AWS_REGION: 'us-east-2',
    STORAGE_BUCKET: 'assets',
  };

  it('returns null unless every storage var is set', () => {
    expect(
      createStorageTarget(fakeConfig({ ...full, STORAGE_BUCKET: undefined })),
    ).toBeNull();
    expect(createStorageTarget(fakeConfig({}))).toBeNull();
  });

  it('builds a path-style S3 client for the bucket', async () => {
    const target = createStorageTarget(fakeConfig(full));
    expect(target?.bucket).toBe('assets');
    expect(target?.client.config.forcePathStyle).toBe(true);
    await expect(target?.client.config.region()).resolves.toBe('us-east-2');
    target?.client.destroy();
  });
});
