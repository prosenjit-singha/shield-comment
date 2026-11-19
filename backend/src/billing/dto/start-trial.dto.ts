import { IsUUID } from 'class-validator';

/** `POST /api/workspaces/:workspaceId/billing/trial` body (PR-T3). */
export class StartTrialDto {
  /** A plan with a live trial (`GET /api/plans` → `trial`). */
  @IsUUID()
  planId!: string;
}
