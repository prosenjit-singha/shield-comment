import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
  type RawBodyRequest,
} from '@nestjs/common';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

/** Full path of the Meta webhook route (global prefix `api` + `webhooks/meta`, Module 4 D1). */
export const META_WEBHOOK_PATH = '/api/webhooks/meta';

/** Largest webhook body we read. Meta batches entries, but real payloads stay far below this. */
export const META_WEBHOOK_BODY_LIMIT = '1mb';

/**
 * Reads the exact bytes of `POST /api/webhooks/meta` into `req.rawBody` (any content type) for the
 * HMAC check, and leaves `req.body` undefined (the handler parses JSON after the guard).
 *
 * Mounted by `configureApp()` with `app.use(META_WEBHOOK_PATH, …)` before `init()`, so it runs ahead
 * of the Better Auth integration's JSON/urlencoded parsers (Nest module middleware). Those parsers
 * then see a consumed stream and skip it. Every other route is untouched. Parser errors become
 * `HttpException`s, so Nest's error handler renders them with `AllExceptionsFilter`.
 */
export function metaWebhookRawBody(): RequestHandler {
  const parse = express.raw({
    type: () => true,
    limit: META_WEBHOOK_BODY_LIMIT,
  });
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    parse(req, res, (error?: unknown) => {
      if (error) {
        next(toHttpException(error));
        return;
      }
      const body: unknown = req.body;
      (req as RawBodyRequest<Request>).rawBody = Buffer.isBuffer(body)
        ? body
        : Buffer.alloc(0);
      req.body = undefined;
      next();
    });
  };
}

function toHttpException(error: unknown): HttpException {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status: unknown }).status
      : undefined;
  if (status === 413) {
    return new PayloadTooLargeException('Request body too large');
  }
  // Aborted/size-mismatch/unsupported-encoding: never echo the parser's message.
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new HttpException('Invalid request body', status);
  }
  return new BadRequestException('Invalid request body');
}
