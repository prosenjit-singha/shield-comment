import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Super Admin view of all client workspaces. Cross-tenant by design, so guarded. */
@Controller('admin/clients')
@UseGuards(SuperAdminGuard)
export class AdminClientsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip: number,
    @Query('take', new DefaultValuePipe(50), ParseIntPipe) take: number,
  ) {
    const safeTake = Math.min(Math.max(take, 1), 100);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workspace.findMany({
        skip: Math.max(skip, 0),
        take: safeTake,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          createdAt: true,
          owner: { select: { id: true, email: true, name: true } },
          _count: { select: { members: true } },
        },
      }),
      this.prisma.workspace.count(),
    ]);
    return { items, total, skip: Math.max(skip, 0), take: safeTake };
  }
}
