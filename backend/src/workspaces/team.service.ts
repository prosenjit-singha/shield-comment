import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { LimitService, type SeatUsage } from '../billing/limit.service.js';
import type { Database } from '../db/database.js';
import {
  users,
  workspaceInvitations,
  workspaceMembers,
} from '../db/schema/index.js';

export interface TeamView {
  /** Owner first, then by join date. */
  members: {
    memberId: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    joinedAt: Date;
  }[];
  /** Pending, unexpired invites, oldest first. */
  invitations: {
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
    inviterName: string;
  }[];
  /** Pooled on the workspace's billing account (D9); `limit` null without a live plan. */
  seats: SeatUsage;
}

/** C11 `/settings/team` read model (M7-T6). Every query is scoped by `workspace_id`. */
@Injectable()
export class TeamService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly limits: LimitService,
  ) {}

  async team(workspaceId: string, now: Date = new Date()): Promise<TeamView> {
    const [members, invitations, seats] = await Promise.all([
      this.db
        .select({
          memberId: workspaceMembers.id,
          userId: workspaceMembers.userId,
          name: users.name,
          email: users.email,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.createdAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, workspaceId))
        .orderBy(
          sql`${workspaceMembers.role} <> 'owner'`,
          asc(workspaceMembers.createdAt),
          asc(workspaceMembers.id),
        ),
      this.db
        .select({
          id: workspaceInvitations.id,
          email: workspaceInvitations.email,
          role: workspaceInvitations.role,
          expiresAt: workspaceInvitations.expiresAt,
          inviterName: users.name,
        })
        .from(workspaceInvitations)
        .innerJoin(users, eq(users.id, workspaceInvitations.inviterId))
        .where(
          and(
            eq(workspaceInvitations.workspaceId, workspaceId),
            eq(workspaceInvitations.status, 'pending'),
            gt(workspaceInvitations.expiresAt, now),
          ),
        )
        .orderBy(
          asc(workspaceInvitations.createdAt),
          asc(workspaceInvitations.id),
        ),
      this.limits.seatUsage(workspaceId, now),
    ]);
    return { members, invitations, seats };
  }
}
