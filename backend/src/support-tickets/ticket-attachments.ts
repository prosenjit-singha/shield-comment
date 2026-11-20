import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { asc, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Database } from '../db/database.js';
import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_TYPES,
  TICKET_ATTACHMENTS_PER_MESSAGE,
  ticketAttachments,
  type TicketAttachmentType,
} from '../db/schema/index.js';
import { assertValidKey, StorageService } from '../storage/storage.service.js';

/** Multipart field that carries a message's images (M7-T3). */
export const ATTACHMENT_FIELD = 'files';

export const ATTACHMENT_ERROR_CODES = {
  /** 400: more than `TICKET_ATTACHMENTS_PER_MESSAGE` files on one message. */
  tooMany: 'ATTACHMENT_TOO_MANY',
  /** 400: a file is over `TICKET_ATTACHMENT_MAX_BYTES`. */
  tooLarge: 'ATTACHMENT_TOO_LARGE',
  /** 400: declared type not PNG/JPEG/WebP, or the bytes are not that type. */
  typeInvalid: 'ATTACHMENT_TYPE_INVALID',
  /** 409: object storage is not configured; nothing was written. */
  unavailable: 'ATTACHMENTS_UNAVAILABLE',
} as const;

/** The parts of a multer memory-storage file we read (no `@types/multer` needed). */
export interface UploadedImage {
  mimetype: string;
  size: number;
  buffer: Uint8Array;
}

export interface ValidImage {
  contentType: TicketAttachmentType;
  body: Uint8Array;
  sizeBytes: number;
}

/** A stored object, ready to be inserted as a `ticket_attachments` row. */
export interface StagedAttachment {
  id: string;
  ticketId: string;
  messageId: string;
  storageKey: string;
  contentType: TicketAttachmentType;
  sizeBytes: number;
}

/** What thread responses show; `url` is a short-lived presigned GET, `null` when storage is off. */
export interface AttachmentView {
  id: string;
  contentType: TicketAttachmentType;
  sizeBytes: number;
  url: string | null;
}

const EXTENSIONS: Record<TicketAttachmentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const startsWith = (bytes: Uint8Array, at: number, sig: number[]) =>
  sig.every((b, i) => bytes[at + i] === b);

/** The image type the magic bytes say, or `null` (PNG `89 50 4E 47`, JPEG `FF D8 FF`, WebP `RIFF....WEBP`). */
export function sniffImageType(bytes: Uint8Array): TicketAttachmentType | null {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  )
    return 'image/webp';
  return null;
}

export function attachmentError(
  kind: Exclude<keyof typeof ATTACHMENT_ERROR_CODES, 'unavailable'>,
): BadRequestException {
  const messages = {
    tooMany: `Attach at most ${TICKET_ATTACHMENTS_PER_MESSAGE} images per message`,
    tooLarge: `Each image must be ${TICKET_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB or smaller`,
    typeInvalid: 'Only PNG, JPEG or WebP images can be attached',
  };
  return new BadRequestException({
    message: messages[kind],
    error: 'Bad Request',
    code: ATTACHMENT_ERROR_CODES[kind],
  });
}

const isAllowedType = (type: string): type is TicketAttachmentType =>
  (TICKET_ATTACHMENT_TYPES as readonly string[]).includes(type);

/**
 * D4: ≤ 3 files, each 1 byte – 5 MB, declared type PNG/JPEG/WebP **and** the magic bytes are that
 * type. Throws a 400 with an `ATTACHMENT_*` code; nothing is written before this passes.
 */
export function validateAttachments(
  files: readonly UploadedImage[] | undefined,
): ValidImage[] {
  if (!files?.length) return [];
  if (files.length > TICKET_ATTACHMENTS_PER_MESSAGE)
    throw attachmentError('tooMany');
  return files.map((file) => {
    const body = file.buffer;
    if (body.byteLength > TICKET_ATTACHMENT_MAX_BYTES)
      throw attachmentError('tooLarge');
    if (!isAllowedType(file.mimetype) || sniffImageType(body) !== file.mimetype)
      throw attachmentError('typeInvalid');
    return { contentType: file.mimetype, body, sizeBytes: body.byteLength };
  });
}

/** `tickets/<ticketId>/<messageId>/<attachmentId>.<ext>` (passes `assertValidKey`). */
export function attachmentKey(
  ticketId: string,
  messageId: string,
  attachmentId: string,
  type: TicketAttachmentType,
): string {
  const key = `tickets/${ticketId}/${messageId}/${attachmentId}.${EXTENSIONS[type]}`;
  assertValidKey(key);
  return key;
}

/**
 * Stores ticket screenshots in `StorageService` and reads them back as presigned URLs (M7-T3, D4).
 * Order on write: validate (caller) → put objects → DB transaction → on failure best-effort delete.
 */
@Injectable()
export class TicketAttachmentsService {
  private readonly logger = new Logger(TicketAttachmentsService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly storage: StorageService,
  ) {}

  /**
   * Puts `images` under `ticketId`/`messageId`, then runs `write(staged)` (the transaction that
   * inserts the message + the `ticket_attachments` rows). If `write` throws, the stored objects are
   * deleted (logged, never masks the error). No images → just `write([])`, storage untouched.
   * 409 `ATTACHMENTS_UNAVAILABLE` when storage is not configured (nothing written).
   */
  async withUploads<T>(
    ticketId: string,
    messageId: string,
    images: readonly ValidImage[],
    write: (staged: StagedAttachment[]) => Promise<T>,
  ): Promise<T> {
    if (!images.length) return write([]);
    if (!this.storage.enabled)
      throw new ConflictException({
        message: 'Attachments are not available right now',
        error: 'Conflict',
        code: ATTACHMENT_ERROR_CODES.unavailable,
      });
    const staged: StagedAttachment[] = [];
    try {
      for (const image of images) {
        const id = uuidv7();
        const storageKey = attachmentKey(
          ticketId,
          messageId,
          id,
          image.contentType,
        );
        await this.storage.put(storageKey, image.body, {
          contentType: image.contentType,
          cacheControl: 'private, max-age=900',
        });
        staged.push({
          id,
          ticketId,
          messageId,
          storageKey,
          contentType: image.contentType,
          sizeBytes: image.sizeBytes,
        });
      }
      return await write(staged);
    } catch (error) {
      await this.discard(staged);
      throw error;
    }
  }

  /** Attachments of these messages (oldest first) with presigned URLs; `url: null` if storage is off or signing fails. */
  async viewsFor(
    messageIds: readonly string[],
  ): Promise<Map<string, AttachmentView[]>> {
    const byMessage = new Map<string, AttachmentView[]>();
    if (!messageIds.length) return byMessage;
    const rows = await this.db
      .select({
        id: ticketAttachments.id,
        messageId: ticketAttachments.messageId,
        storageKey: ticketAttachments.storageKey,
        contentType: ticketAttachments.contentType,
        sizeBytes: ticketAttachments.sizeBytes,
      })
      .from(ticketAttachments)
      .where(inArray(ticketAttachments.messageId, [...messageIds]))
      .orderBy(asc(ticketAttachments.createdAt), asc(ticketAttachments.id));
    const views = await Promise.all(
      rows.map(async (row) => ({
        messageId: row.messageId,
        view: {
          id: row.id,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          url: await this.presign(row.storageKey),
        },
      })),
    );
    for (const { messageId, view } of views) {
      const list = byMessage.get(messageId) ?? [];
      list.push(view);
      byMessage.set(messageId, list);
    }
    return byMessage;
  }

  /** A thread must never 5xx because of storage. */
  private async presign(key: string): Promise<string | null> {
    if (!this.storage.enabled) return null;
    try {
      return await this.storage.presignGet(key);
    } catch (error) {
      this.logger.warn(
        `presign failed for ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async discard(staged: readonly StagedAttachment[]): Promise<void> {
    for (const { storageKey } of staged) {
      try {
        await this.storage.delete(storageKey);
      } catch (error) {
        this.logger.error(
          `orphaned ticket attachment ${storageKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
