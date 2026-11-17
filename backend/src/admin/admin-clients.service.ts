import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { users, workspaceMembers, workspaces } from '../db/schema/index.js';

export interface ClientOwner {
  id: string;
  email: string;
  name: string;
}

/**
 * Super admin view of every client workspace. Cross-tenant by design (only reachable through
 * `SuperAdminGuard`); the member/owner lookups are still scoped to the page's workspace ids.
 */
@Injectable()
export class AdminClientsService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async list(skip: number, take: number) {
    const [page, [totals]] = await Promise.all([
      this.db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          slug: workspaces.slug,
          status: workspaces.status,
          createdAt: workspaces.createdAt,
        })
        .from(workspaces)
        .orderBy(desc(workspaces.createdAt), desc(workspaces.id))
        .offset(skip)
        .limit(take),
      this.db.select({ total: count() }).from(workspaces),
    ]);

    const ids = page.map((w) => w.id);
    const [owners, memberCounts] = ids.length
      ? await Promise.all([
          this.db
            .select({
              workspaceId: workspaceMembers.workspaceId,
              id: users.id,
              email: users.email,
              name: users.name,
            })
            .from(workspaceMembers)
            .innerJoin(users, eq(users.id, workspaceMembers.userId))
            .where(
              and(
                inArray(workspaceMembers.workspaceId, ids),
                eq(workspaceMembers.role, 'owner'),
              ),
            )
            .orderBy(asc(workspaceMembers.createdAt)),
          this.db
            .select({
              workspaceId: workspaceMembers.workspaceId,
              total: count(),
            })
            .from(workspaceMembers)
            .where(inArray(workspaceMembers.workspaceId, ids))
            .groupBy(workspaceMembers.workspaceId),
        ])
      : [[], []];

    // Oldest owner wins if a workspace has several.
    const ownerOf = new Map<string, ClientOwner>();
    for (const { workspaceId, ...owner } of owners) {
      if (!ownerOf.has(workspaceId)) ownerOf.set(workspaceId, owner);
    }
    const membersOf = new Map(
      memberCounts.map((m) => [m.workspaceId, m.total]),
    );

    return {
      items: page.map((w) => ({
        ...w,
        owner: ownerOf.get(w.id) ?? null,
        memberCount: membersOf.get(w.id) ?? 0,
      })),
      total: totals?.total ?? 0,
      skip,
      take,
    };
  }
}
