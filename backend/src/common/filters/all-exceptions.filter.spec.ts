import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function run(exception: unknown) {
  const json = vi.fn();
  const status = vi.fn<(code: number) => { json: typeof json }>(() => ({
    json,
  }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ originalUrl: '/api/x?token=secret' }),
    }),
  } as unknown as ArgumentsHost;
  const filter = new AllExceptionsFilter();
  // 5xx are logged; keep test output quiet.
  vi.spyOn(
    (filter as unknown as { logger: { error: () => void } }).logger,
    'error',
  ).mockImplementation(() => undefined);
  filter.catch(exception, host);
  return {
    status: status.mock.calls[0]?.[0] as number,
    body: json.mock.calls[0]?.[0] as Record<string, unknown>,
  };
}

describe('AllExceptionsFilter', () => {
  it('keeps the standard shape for a plain HttpException (no code/details keys)', () => {
    const { status, body } = run(new NotFoundException('Page not found'));
    expect(status).toBe(404);
    expect(Object.keys(body).sort()).toEqual(
      ['error', 'message', 'path', 'statusCode', 'timestamp'].sort(),
    );
    expect(body).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      message: 'Page not found',
      path: '/api/x?token=%5BRedacted%5D',
    });
  });

  it('keeps `code` and object `details` on a 4xx body', () => {
    const { body } = run(
      new ConflictException({
        message: 'Limit reached',
        error: 'Conflict',
        code: 'PAGE_LIMIT_REACHED',
        details: { limit: 1, activeCount: 1 },
      }),
    );
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      message: 'Limit reached',
      code: 'PAGE_LIMIT_REACHED',
      details: { limit: 1, activeCount: 1 },
    });
  });

  it('drops a non-string code, non-object details and any other extra field', () => {
    const { body } = run(
      new BadRequestException({
        message: 'bad',
        code: 42,
        details: ['x'],
        secret: 'nope',
      }),
    );
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('details');
    expect(body).not.toHaveProperty('secret');
  });

  it('never passes other codes or details on 5xx', () => {
    const { status, body } = run(
      new HttpException({ message: 'boom', code: 'X', details: { a: 1 } }, 503),
    );
    expect(status).toBe(503);
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('details');
  });

  it('keeps an allow-listed code on 5xx (502 META_SUBSCRIBE_FAILED), never details', () => {
    const { status, body } = run(
      new HttpException(
        {
          message: 'Facebook did not confirm',
          error: 'Bad Gateway',
          code: 'META_SUBSCRIBE_FAILED',
          details: { a: 1 },
        },
        502,
      ),
    );
    expect(status).toBe(502);
    expect(body).toMatchObject({
      statusCode: 502,
      error: 'Bad Gateway',
      code: 'META_SUBSCRIBE_FAILED',
    });
    expect(body).not.toHaveProperty('details');
  });

  it('hides internals of unknown errors', () => {
    const { status, body } = run(new Error('db password in message'));
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
  });
});
