import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { Database } from '../db/database.js';
import {
  findPlanFeatureConfig,
  findWorkspacePlanId,
  type PagesExecutor,
} from '../meta/social-pages.queries.js';
import type {
  ModerationPolicyResponse,
  ModerationPolicyUpdateResponse,
  UpdateModerationPolicyDto,
} from './dto/moderation-policy.dto.js';
import type { DecisionPlanFeatures } from './moderation-decision.js';
import {
  applyPolicyPatch,
  assertPolicyPatchAllowed,
  isEmptyPolicyPatch,
  policyColumns,
  samePolicy,
  toPolicyResponse,
} from './moderation-policy.rules.js';
import {
  getOrCreateModerationPolicy,
  lockModerationPolicy,
  type ModerationPolicy,
  toModerationPolicy,
  updateModerationPolicy,
} from './moderation.queries.js';

/**
 * The plan flags moderation reads (D6), from the workspace's plan or the Free plan when it has
 * none (Module 3 D10). A missing plan row fails closed (no auto-reply).
 */
export async function workspacePlanFeatures(
  executor: PagesExecutor,
  workspaceId: string,
): Promise<DecisionPlanFeatures> {
  const workspace = await findWorkspacePlanId(executor, workspaceId);
  const raw = await findPlanFeatureConfig(executor, workspace?.planId ?? null);
  if (raw === undefined || raw === null) return { autoReplyTemplates: false };
  return {
    autoReplyTemplates: normalizeFeatureConfig(raw).features.autoReplyTemplates,
  };
}

/**
 * Workspace moderation policy (M5-T8; D3/D4/D5/D6/D8 answered 2026-11-19). The controller has
 * already passed `WorkspaceAccessGuard` + `@Roles('owner','admin')`, so `workspaceId` is a
 * workspace the session may manage. The worker (M5-T12) reads the policy through `policy()`.
 */
@Injectable()
export class ModerationPolicyService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** The decision-code view (row created with the defaults on first use). */
  async policy(workspaceId: string): Promise<ModerationPolicy> {
    return toModerationPolicy(
      await getOrCreateModerationPolicy(this.db, workspaceId),
    );
  }

  /** `GET`: the policy (lazy default row, D5) + `autoReplyAvailable`. */
  async get(workspaceId: string): Promise<ModerationPolicyResponse> {
    const row = await getOrCreateModerationPolicy(this.db, workspaceId);
    return toPolicyResponse(
      row,
      await workspacePlanFeatures(this.db, workspaceId),
    );
  }

  /**
   * `PATCH`, one transaction: get-or-create the row, `FOR UPDATE` on it (concurrent PATCHes of a
   * workspace run one at a time), read the plan flags, merge, check (409 plan feature, 400 texts
   * missing), then write only when something changed (same values = no UPDATE, `updatedAt` kept,
   * `changed: false`). An empty body → 400 before any query.
   */
  async update(
    workspaceId: string,
    patch: UpdateModerationPolicyDto,
  ): Promise<ModerationPolicyUpdateResponse> {
    if (isEmptyPolicyPatch(patch)) {
      throw new BadRequestException('Nothing to update');
    }
    return this.db.transaction(async (tx) => {
      await getOrCreateModerationPolicy(tx, workspaceId);
      const row = await lockModerationPolicy(tx, workspaceId);
      if (!row) throw new NotFoundException('Moderation policy not found');
      const features = await workspacePlanFeatures(tx, workspaceId);
      const current = toModerationPolicy(row);
      const next = applyPolicyPatch(current, patch);
      assertPolicyPatchAllowed(patch, next, features);
      if (samePolicy(current, next)) {
        return { ...toPolicyResponse(row, features), changed: false };
      }
      const updated = await updateModerationPolicy(
        tx,
        workspaceId,
        policyColumns(next),
      );
      if (!updated) throw new NotFoundException('Moderation policy not found');
      return { ...toPolicyResponse(updated, features), changed: true };
    });
  }
}
