import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  COMMENT_PLATFORMS,
  type CommentPlatform,
} from '../../db/schema/comments.js';
import type { ClassificationOutput } from '../classifier-output.js';
import type { ModerationDecision } from '../moderation-decision.js';
import type { StaticRuleMatch } from '../static-rules.js';

/**
 * Moderation playground (M6-T7, Module 6 D9/D7/D2):
 * `POST /api/workspaces/:workspaceId/playground/test` (every member role, impersonated ok).
 * Runs the workspace's static rules, then (no match) the AI with comment-only context, and
 * returns what the worker would decide for a new VISIBLE comment. Stores no comment, never calls
 * Meta, no wallet charge; a real AI call is added to `daily_ai_usage`.
 *
 * Errors: 400 body; 429 `PLAYGROUND_LIMIT_REACHED` `details { limit, resetsAt }`;
 * 503 `PLAYGROUND_AI_NOT_CONFIGURED` (no AI provider); 502 `PLAYGROUND_AI_FAILED`
 * `details { errorKind, retryable }` (any other classifier failure). A refused or failed test
 * does not count against the daily limit.
 */
export const PLAYGROUND_ERROR_CODES = {
  limitReached: 'PLAYGROUND_LIMIT_REACHED',
  aiNotConfigured: 'PLAYGROUND_AI_NOT_CONFIGURED',
  aiFailed: 'PLAYGROUND_AI_FAILED',
} as const;

export const PLAYGROUND_TEXT_MAX_CHARS = 2_000;

export class PlaygroundTestDto {
  /** Trimmed, 1–2,000 chars (the classifier itself sends at most 1,000). */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(PLAYGROUND_TEXT_MAX_CHARS)
  text!: string;

  /** Default `FACEBOOK`. */
  @IsOptional()
  @IsIn(COMMENT_PLATFORMS)
  platform?: CommentPlatform;
}

export interface PlaygroundTestResponse {
  ruleMatch: StaticRuleMatch | null;
  classification: Pick<
    ClassificationOutput,
    'category' | 'confidence' | 'reasoning' | 'language'
  > | null;
  decision: ModerationDecision;
  /** Wall time of the test (rules + AI), ms. */
  latencyMs: number;
  /** Tests left today (Dhaka day) after this one. */
  testsLeft: number;
}

/** `GET …/playground/usage` (M6-T11): today's count without running a test. */
export interface PlaygroundUsageResponse {
  /** Admin setting `playgroundDailyLimit`; 0 = playground off. */
  limit: number;
  used: number;
  testsLeft: number;
  /** Next Dhaka midnight (ISO). */
  resetsAt: string;
}
