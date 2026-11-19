import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import type { PublicPlansResponse } from './dto/public-plan.dto.js';
import { PlansService } from './plans.service.js';

/**
 * `GET /api/plans` (PW-T6, plan §3.7): the pricing cards' data, no session needed. Cached for
 * 60 s by browsers/proxies (`public`: the body is the same for everyone); an admin price edit
 * shows within a minute.
 */
@Public()
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  list(): Promise<PublicPlansResponse> {
    return this.plans.listPublic();
  }
}
