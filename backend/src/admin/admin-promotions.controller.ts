import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession } from '../auth/auth-session.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminPromotionsService } from './admin-promotions.service.js';
import {
  type AdminPromotionRedemptionsResponse,
  type AdminPromotionResponse,
  type AdminPromotionsResponse,
  CreatePromotionDto,
  ListPromotionsQueryDto,
  UpdatePromotionDto,
} from './dto/promotions.dto.js';

/** `/api/admin/promotions` (PR-T4). Shapes and error codes: `src/admin/dto/promotions.dto.ts`. */
@Controller('admin/promotions')
@UseGuards(SuperAdminGuard)
export class AdminPromotionsController {
  constructor(private readonly promotions: AdminPromotionsService) {}

  @Get()
  list(
    @Query() query: ListPromotionsQueryDto,
  ): Promise<AdminPromotionsResponse> {
    return this.promotions.list(query);
  }

  @Post()
  create(
    @Body() body: CreatePromotionDto,
    @Session() session: AuthSession,
  ): Promise<AdminPromotionResponse> {
    return this.promotions.create(body, session.user.id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdatePromotionDto,
  ): Promise<AdminPromotionResponse> {
    return this.promotions.update(id, body);
  }

  @Post(':id/stop')
  @HttpCode(200)
  stop(
    @Param('id') id: string,
    @Session() session: AuthSession,
  ): Promise<AdminPromotionResponse> {
    return this.promotions.stop(id, session.user.id);
  }

  @Get(':id/redemptions')
  redemptions(
    @Param('id') id: string,
  ): Promise<AdminPromotionRedemptionsResponse> {
    return this.promotions.redemptions(id);
  }
}
