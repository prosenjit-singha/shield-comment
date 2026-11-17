import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminClientsService } from './admin-clients.service.js';
import { ListClientsQueryDto } from './dto/list-clients-query.dto.js';

@Controller('admin/clients')
@UseGuards(SuperAdminGuard)
export class AdminClientsController {
  constructor(private readonly clients: AdminClientsService) {}

  /** Newest first: `{ items: [{ id, name, slug, status, createdAt, owner, memberCount }], total, skip, take }`. */
  @Get()
  list(@Query() query: ListClientsQueryDto) {
    return this.clients.list(query.skip, query.take);
  }
}
