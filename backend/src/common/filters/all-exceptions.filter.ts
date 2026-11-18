import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { redactUrlQuery } from '../logging/redact-query.js';

export interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  /** Machine-readable reason, set by the thrower (`HttpException` body `code`), e.g. `PAGE_LIMIT_REACHED`. */
  code?: string;
  /** Extra numbers/strings for the UI (`HttpException` body `details`), never on 5xx. */
  details?: Record<string, unknown>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Normalises every error into one JSON shape; never leaks internals on 5xx. A 4xx `HttpException`
 * whose body carries `code` (string) and/or `details` (object) keeps them (M3-T6 page limit 409).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const path = redactUrlQuery(req.originalUrl);

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        error = exception.name;
      } else {
        const b = body as {
          message?: string | string[];
          error?: string;
          code?: unknown;
          details?: unknown;
        };
        message = b.message ?? exception.message;
        error = b.error ?? exception.name;
        if (statusCode < 500) {
          if (typeof b.code === 'string') code = b.code;
          if (isPlainObject(b.details)) details = b.details;
        }
      }
    }

    if (statusCode >= 500) {
      this.logger.error(
        { err: exception, path },
        exception instanceof Error ? exception.message : 'Unknown error',
      );
    }

    const payload: ErrorBody = {
      statusCode,
      error,
      message,
      path,
      timestamp: new Date().toISOString(),
      ...(code === undefined ? {} : { code }),
      ...(details === undefined ? {} : { details }),
    };
    res.status(statusCode).json(payload);
  }
}
