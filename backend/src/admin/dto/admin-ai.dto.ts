import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { AiProvider } from '../../ai-gateway/ai-provider.js';
import {
  AI_CREDIT_TOPUP_NOTE_MAX,
  type CommentPlatform,
} from '../../db/schema/index.js';
import type {
  CommentStatus,
  ModerationActionState,
  ModerationCategory,
  PolicyAction,
} from '../../moderation/moderation.constants.js';
import { IsDateOnly } from './activate-client-plan.dto.js';

/**
 * Admin AI analysis log, credit top-ups and spend summary (M5-T15d; user decisions 2026-11-20
 * D25/D26). SuperAdminGuard, platform-wide (not tenant routes). The admin app mirrors these types
 * (M5-T15e). Costs are **estimates**: tokens × catalog prices (USD per 1M); unknown price → `null`.
 *
 * - `GET /api/admin/ai/analyses?limit=1..20` (default 20) → `{ items: AiAnalysis[] }`, newest
 *   `classifiedAt` first.
 * - `GET /api/admin/ai/summary` → `AiSpendSummary`.
 * - `GET /api/admin/ai/credit-topups` → `{ items: AiCreditTopup[] }`, newest `toppedUpOn` first.
 * - `POST /api/admin/ai/credit-topups` (`CreateAiCreditTopupDto`) → 201 `{ topup }`; 400
 *   `{ code: 'TOPUP_DATE_IN_FUTURE' }` for a date after today (Asia/Dhaka).
 * - `DELETE /api/admin/ai/credit-topups/:id` → 204; 404 unknown.
 */

export const AI_ANALYSES_LIMIT_MAX = 20;
/** Sanity bound of one top-up (USD; the column holds numeric(10,2)). */
export const AI_CREDIT_TOPUP_AMOUNT_MAX = 1_000_000;

export class ListAiAnalysesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AI_ANALYSES_LIMIT_MAX)
  limit?: number;
}

export class CreateAiCreditTopupDto {
  /** USD, > 0, at most 2 decimals. */
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(AI_CREDIT_TOPUP_AMOUNT_MAX)
  amountUsd!: number;

  /** Asia/Dhaka calendar date of the top-up, `YYYY-MM-DD`, not in the future. */
  @IsDateOnly()
  toppedUpOn!: string;

  /** Optional; trimmed (blank = none), ≤ 200 characters. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(AI_CREDIT_TOPUP_NOTE_MAX)
  note?: string | null;
}

/** The AI's action for the comment: `NONE` = Allowed, `HIDE` = Hidden, `DELETE` = Deleted. */
export type AiDecision = PolicyAction;

/** One analyzed comment. `message` is untrusted client data: admin-only, never logged. */
export interface AiAnalysis {
  /** `comments.id`. */
  id: string;
  classifiedAt: Date;
  workspace: { id: string; name: string };
  /** `null` once the Page was disconnected. `pageId` = the Meta Page id. */
  page: { id: string; pageId: string; name: string } | null;
  platform: CommentPlatform;
  message: string | null;
  category: ModerationCategory;
  confidence: number;
  /** From the latest AUTO hide / unhide / delete since the classification (none or unhide = `NONE`). */
  decision: AiDecision;
  /** State of that Meta action (`null` = no action). */
  actionState: ModerationActionState | null;
  /** Stored comment status + reason (e.g. `FAILED` + Meta error kind, `NEEDS_REVIEW` + `below_threshold`). */
  status: CommentStatus;
  statusReason: string | null;
  provider: AiProvider;
  model: string;
  /** Counts (the UI formats `0.4k`); `null` = not reported or classified before M5-T15d. */
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  /** 6 dp; `null` = tokens or price unknown. */
  estimatedCostUsd: number | null;
}

export interface AiAnalysesResponse {
  items: AiAnalysis[];
}

export interface AiSpendByModel {
  provider: AiProvider;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** `null` = unknown price. */
  costUsd: number | null;
}

export interface AiSpendByDecision {
  decision: AiDecision;
  /** Analyzed comments with this decision. */
  comments: number;
  /** Of the priced comments only (6 dp). */
  costUsd: number;
  /** Comments without tokens or with an unknown price (counted, cost 0). */
  unpricedComments: number;
}

export interface AiSpendSummary {
  asOf: Date;
  timezone: 'Asia/Dhaka';
  /** Sum of the top-ups (2 dp). */
  creditAddedUsd: number;
  /** Every stored AI call (`daily_ai_usage`) × prices, priced models only (6 dp). */
  estimatedSpendUsd: number;
  /** added − spend (6 dp); may be negative. */
  estimatedRemainingUsd: number;
  /** Calls on models with an unknown price (not in the spend). */
  unpricedCalls: number;
  /** Comments with a stored classification, by `classified_at` (Dhaka days; 7 days incl. today). */
  commentsAnalyzed: { total: number; today: number; last7Days: number };
  tokens: { input: number; output: number };
  spendByModel: AiSpendByModel[];
  /** Always `NONE`, `HIDE`, `DELETE` in that order. */
  spendByDecision: AiSpendByDecision[];
}

export interface AiCreditTopup {
  id: string;
  amountUsd: number;
  toppedUpOn: string;
  note: string | null;
  createdAt: Date;
  createdBy: { id: string; name: string };
}

export interface AiCreditTopupsResponse {
  items: AiCreditTopup[];
}
