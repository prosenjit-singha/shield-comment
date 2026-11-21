import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator.js';
import { DATA_DELETION_CODE_PATTERN } from '../db/schema/index.js';
import {
  META_CALLBACKS_CONFIG,
  type MetaCallbacksConfig,
} from './meta-callbacks.config.js';
import {
  type DataDeletionCallbackResponse,
  type DataDeletionStatusResponse,
  MetaDataDeletionService,
} from './meta-data-deletion.service.js';
import { MetaDeauthorizeService } from './meta-deauthorize.service.js';
import {
  type MetaSignedRequest,
  parseMetaSignedRequest,
  signedRequestFailureStatus,
} from './meta-signed-request.js';

/**
 * Meta platform callbacks (Module 4 D6, M4-T6), called by Meta's servers (no session →
 * `@Public()`), rate-limited per IP (`ThrottlerGuard` on `req.ip` = the resolved client IP, M9-T1).
 * Body: `application/x-www-form-urlencoded` `signed_request=…` (parsed by the Better Auth
 * integration's urlencoded parser, which covers every non-auth route). The signed_request is never
 * logged or echoed.
 * - `POST /api/meta/deauthorize` → 200 `{ success: true }` (also for unknown users and repeats).
 * - `POST /api/meta/data-deletion` → 200 `{ url, confirmation_code }` (Meta's contract).
 * - `GET /api/meta/data-deletion/:code` → `{ status, requestedAt, completedAt }`, 404 unknown.
 * Missing/malformed/unusable signed_request → 400, bad signature → 401, `META_APP_SECRET` unset → 503.
 */
@Public()
@UseGuards(ThrottlerGuard)
@SkipThrottle({ global: true })
@Controller('meta')
export class MetaCallbacksController {
  private readonly logger = new Logger('MetaCallbacks');

  constructor(
    @Inject(META_CALLBACKS_CONFIG) private readonly config: MetaCallbacksConfig,
    private readonly deauthorizeService: MetaDeauthorizeService,
    private readonly dataDeletion: MetaDataDeletionService,
  ) {}

  @Post('deauthorize')
  @HttpCode(200)
  async deauthorize(
    @Body('signed_request') signedRequest: unknown,
  ): Promise<{ success: true }> {
    const { userId } = this.verify(signedRequest, 'deauthorize');
    await this.deauthorizeService.deauthorize(userId);
    return { success: true };
  }

  @Post('data-deletion')
  @HttpCode(200)
  dataDeletionRequest(
    @Body('signed_request') signedRequest: unknown,
  ): Promise<DataDeletionCallbackResponse> {
    const { userId } = this.verify(signedRequest, 'data-deletion');
    return this.dataDeletion.request(userId);
  }

  @Get('data-deletion/:code')
  @Header('Cache-Control', 'no-store')
  async dataDeletionStatus(
    @Param('code') code: string,
  ): Promise<DataDeletionStatusResponse> {
    const status = DATA_DELETION_CODE_PATTERN.test(code)
      ? await this.dataDeletion.status(code)
      : undefined;
    if (!status) throw new NotFoundException('Unknown confirmation code');
    return status;
  }

  private verify(value: unknown, route: string): MetaSignedRequest {
    const appSecret = this.config.appSecret;
    if (!appSecret) {
      throw new ServiceUnavailableException(
        'Meta callbacks are not configured',
      );
    }
    const result = parseMetaSignedRequest(value, appSecret);
    if (result.ok) return result.value;
    this.logger.warn(`Meta ${route} rejected: signed_request ${result.reason}`);
    if (signedRequestFailureStatus(result.reason) === 401) {
      throw new UnauthorizedException('Invalid signed_request');
    }
    throw new BadRequestException('Invalid signed_request');
  }
}
