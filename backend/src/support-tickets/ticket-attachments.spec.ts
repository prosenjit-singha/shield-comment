import {
  BadRequestException,
  ConflictException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Database } from '../db/database.js';
import type { StorageService } from '../storage/storage.service.js';
import {
  attachmentKey,
  sniffImageType,
  TicketAttachmentsService,
  validateAttachments,
  type UploadedImage,
  type ValidImage,
} from './ticket-attachments.js';
import { mapUploadError } from './ticket-files.interceptor.js';

const TICKET = '019a0000-0000-7000-8000-000000000001';
const MESSAGE = '019a0000-0000-7000-8000-0000000000ee';
const MB = 1024 * 1024;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')];

const bytes = (head: number[], size = head.length) => {
  const b = new Uint8Array(size);
  b.set(head);
  return b;
};
const file = (mimetype: string, head: number[], size?: number) => {
  const buffer = bytes(head, size);
  return { mimetype, size: buffer.byteLength, buffer } as UploadedImage;
};

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { code: string })
      .code;
  }
  throw new Error('did not throw');
}

describe('sniffImageType', () => {
  it('recognises PNG, JPEG and WebP by their magic bytes', () => {
    expect(sniffImageType(bytes(PNG))).toBe('image/png');
    expect(sniffImageType(bytes(JPEG))).toBe('image/jpeg');
    expect(sniffImageType(bytes(WEBP))).toBe('image/webp');
  });

  it('rejects text, GIF, RIFF that is not WEBP (WAV) and empty input', () => {
    expect(sniffImageType(Buffer.from('hello, not an image'))).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('validateAttachments (D4)', () => {
  it('no files → []', () => {
    expect(validateAttachments(undefined)).toEqual([]);
    expect(validateAttachments([])).toEqual([]);
  });

  it('accepts up to 3 matching images, keeps type and size', () => {
    const out = validateAttachments([
      file('image/png', PNG),
      file('image/jpeg', JPEG, 5 * MB),
      file('image/webp', WEBP),
    ]);
    expect(out.map((i) => [i.contentType, i.sizeBytes])).toEqual([
      ['image/png', PNG.length],
      ['image/jpeg', 5 * MB],
      ['image/webp', WEBP.length],
    ]);
  });

  it('400 ATTACHMENT_TOO_MANY for 4 files', () => {
    expect(
      codeOf(() => validateAttachments(Array(4).fill(file('image/png', PNG)))),
    ).toBe('ATTACHMENT_TOO_MANY');
  });

  it('400 ATTACHMENT_TOO_LARGE over 5 MB', () => {
    expect(
      codeOf(() => validateAttachments([file('image/png', PNG, 5 * MB + 1)])),
    ).toBe('ATTACHMENT_TOO_LARGE');
  });

  it('400 ATTACHMENT_TYPE_INVALID: spoofed type, mismatched type, type not allowed, empty file', () => {
    const invalid = [
      file('image/png', [...Buffer.from('just text')]),
      file('image/png', JPEG),
      file('image/gif', [...Buffer.from('GIF89a')]),
      file('image/svg+xml', [...Buffer.from('<svg/>')]),
      file('image/png', []),
    ];
    for (const f of invalid)
      expect(codeOf(() => validateAttachments([f]))).toBe(
        'ATTACHMENT_TYPE_INVALID',
      );
  });
});

describe('attachmentKey', () => {
  it('tickets/<ticket>/<message>/<id>.<ext>', () => {
    expect(attachmentKey(TICKET, MESSAGE, 'a1', 'image/jpeg')).toBe(
      `tickets/${TICKET}/${MESSAGE}/a1.jpg`,
    );
    expect(attachmentKey(TICKET, MESSAGE, 'a2', 'image/webp')).toMatch(
      /\/a2\.webp$/,
    );
  });

  it('refuses keys that would escape the prefix', () => {
    expect(() => attachmentKey('..', MESSAGE, 'a', 'image/png')).toThrow(
      /Invalid object key/,
    );
  });
});

describe('mapUploadError (multer limits)', () => {
  const multer = (code: string, Exc = BadRequestException) =>
    new Exc('x', { cause: Object.assign(new Error('x'), { code }) });

  it('maps LIMIT_FILE_SIZE / LIMIT_FILE_COUNT to the ATTACHMENT_* 400s', () => {
    const size = mapUploadError(
      multer('LIMIT_FILE_SIZE', PayloadTooLargeException),
    ) as BadRequestException;
    expect(size.getStatus()).toBe(400);
    expect(size.getResponse()).toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
    expect(
      (
        mapUploadError(multer('LIMIT_FILE_COUNT')) as BadRequestException
      ).getResponse(),
    ).toMatchObject({ code: 'ATTACHMENT_TOO_MANY' });
  });

  it('leaves other errors alone', () => {
    const other = multer('LIMIT_UNEXPECTED_FILE');
    expect(mapUploadError(other)).toBe(other);
    const plain = new Error('boom');
    expect(mapUploadError(plain)).toBe(plain);
  });
});

function storageFake(enabled = true) {
  return {
    enabled,
    put: vi.fn<StorageService['put']>(async () => undefined),
    delete: vi.fn<StorageService['delete']>(async () => undefined),
    presignGet: vi.fn<StorageService['presignGet']>(
      async (key) => `https://storage.test/${key}?sig=1`,
    ),
  };
}

function service(
  storage: ReturnType<typeof storageFake>,
  rows: unknown[] = [],
) {
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ orderBy: async () => rows }) }),
    }),
  };
  return new TicketAttachmentsService(
    db as unknown as Database,
    storage as unknown as StorageService,
  );
}

const png: ValidImage = {
  contentType: 'image/png',
  body: bytes(PNG),
  sizeBytes: PNG.length,
};

describe('TicketAttachmentsService.withUploads', () => {
  it('no images: runs the write, never touches storage (even when it is off)', async () => {
    const storage = storageFake(false);
    await expect(
      service(storage).withUploads(TICKET, MESSAGE, [], async (s) => s),
    ).resolves.toEqual([]);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('storage off: 409 ATTACHMENTS_UNAVAILABLE, nothing stored or written', async () => {
    const storage = storageFake(false);
    const write = vi.fn();
    const error = await service(storage)
      .withUploads(TICKET, MESSAGE, [png], write)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'ATTACHMENTS_UNAVAILABLE',
    });
    expect(write).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('puts each image, then writes the staged rows', async () => {
    const storage = storageFake();
    const staged = await service(storage).withUploads(
      TICKET,
      MESSAGE,
      [png, { ...png, contentType: 'image/jpeg' }],
      async (s) => s,
    );
    expect(staged).toHaveLength(2);
    expect(staged[0]).toMatchObject({
      ticketId: TICKET,
      messageId: MESSAGE,
      contentType: 'image/png',
      sizeBytes: PNG.length,
    });
    expect(staged[1]!.storageKey).toMatch(
      new RegExp(`^tickets/${TICKET}/${MESSAGE}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(storage.put.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [
        staged[0]!.storageKey,
        { contentType: 'image/png', cacheControl: 'private, max-age=900' },
      ],
      [
        staged[1]!.storageKey,
        { contentType: 'image/jpeg', cacheControl: 'private, max-age=900' },
      ],
    ]);
  });

  it('DB write fails: deletes the stored objects and rethrows (a failed delete is logged only)', async () => {
    const storage = storageFake();
    storage.delete.mockRejectedValueOnce(new Error('s3 down'));
    const boom = new Error('tx failed');
    await expect(
      service(storage).withUploads(TICKET, MESSAGE, [png, png], () =>
        Promise.reject(boom),
      ),
    ).rejects.toBe(boom);
    const putKeys = storage.put.mock.calls.map((c) => c[0]);
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual(putKeys);
  });

  it('a failed put deletes the objects stored before it', async () => {
    const storage = storageFake();
    storage.put
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('put failed'));
    const write = vi.fn();
    await expect(
      service(storage).withUploads(TICKET, MESSAGE, [png, png], write),
    ).rejects.toThrow('put failed');
    expect(write).not.toHaveBeenCalled();
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual([
      storage.put.mock.calls[0]![0],
    ]);
  });
});

describe('TicketAttachmentsService.viewsFor', () => {
  const rows = [
    {
      id: 'a1',
      messageId: 'm1',
      storageKey: 'tickets/t/m1/a1.png',
      contentType: 'image/png',
      sizeBytes: 10,
    },
    {
      id: 'a2',
      messageId: 'm1',
      storageKey: 'tickets/t/m1/a2.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 20,
    },
    {
      id: 'a3',
      messageId: 'm2',
      storageKey: 'tickets/t/m2/a3.webp',
      contentType: 'image/webp',
      sizeBytes: 30,
    },
  ];

  it('groups by message with presigned URLs', async () => {
    const views = await service(storageFake(), rows).viewsFor(['m1', 'm2']);
    expect(views.get('m1')).toEqual([
      {
        id: 'a1',
        contentType: 'image/png',
        sizeBytes: 10,
        url: 'https://storage.test/tickets/t/m1/a1.png?sig=1',
      },
      {
        id: 'a2',
        contentType: 'image/jpeg',
        sizeBytes: 20,
        url: 'https://storage.test/tickets/t/m1/a2.jpg?sig=1',
      },
    ]);
    expect(views.get('m2')!.map((v) => v.id)).toEqual(['a3']);
  });

  it('storage off at read time: url null, never throws', async () => {
    const storage = storageFake(false);
    const views = await service(storage, rows).viewsFor(['m1', 'm2']);
    expect([...views.values()].flat().map((v) => v.url)).toEqual([
      null,
      null,
      null,
    ]);
    expect(storage.presignGet).not.toHaveBeenCalled();
  });

  it('a failing presign → url null for that one', async () => {
    const storage = storageFake();
    storage.presignGet.mockRejectedValueOnce(new Error('bad key'));
    const views = await service(storage, rows).viewsFor(['m1']);
    expect(views.get('m1')!.map((v) => v.url === null)).toEqual([true, false]);
  });

  it('no message ids → no query', async () => {
    expect((await service(storageFake()).viewsFor([])).size).toBe(0);
  });
});
