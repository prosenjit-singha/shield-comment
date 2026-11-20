import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENTS_PER_MESSAGE,
} from '../db/schema/index.js';
import { ATTACHMENT_FIELD, attachmentError } from './ticket-attachments.js';

/** Memory storage; multer stops reading at the 4th file or the first byte over 5 MB. */
const MulterFiles = FilesInterceptor(
  ATTACHMENT_FIELD,
  TICKET_ATTACHMENTS_PER_MESSAGE,
  {
    limits: {
      files: TICKET_ATTACHMENTS_PER_MESSAGE,
      fileSize: TICKET_ATTACHMENT_MAX_BYTES,
    },
  },
);

/** Maps multer's limit errors (kept as `cause` by Nest) to the `ATTACHMENT_*` 400s. */
export function mapUploadError(error: unknown): unknown {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? cause.code
      : undefined;
  if (code === 'LIMIT_FILE_SIZE') return attachmentError('tooLarge');
  if (code === 'LIMIT_FILE_COUNT') return attachmentError('tooMany');
  return error;
}

/**
 * Parses `multipart/form-data` ticket messages (field `files`, ≤ 3 images); JSON bodies pass
 * through untouched. Runs after the guards, so 401/403/404 come before any parsing.
 */
@Injectable()
export class TicketFilesInterceptor implements NestInterceptor {
  private readonly multer: NestInterceptor = new MulterFiles();

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await this.multer.intercept(context, next);
    } catch (error) {
      throw mapUploadError(error);
    }
  }
}
