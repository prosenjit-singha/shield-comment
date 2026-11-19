-- PW-T6b (PW-D1/D3/D7/D11): the admin reads plans from the live subscription and comments from the wallet,
-- so the last readers of the legacy plan + credit data are gone. Drops: `monthly_credit_usage` (M5-T11 credits),
-- `workspaces.plan_id` (+ FK + index; never written) and `daily_ai_usage.credits` (not written since PW-T4).
-- The counts check of `daily_ai_usage` named `credits`, so it is recreated without it.
DROP TABLE "monthly_credit_usage";--> statement-breakpoint
ALTER TABLE "daily_ai_usage" DROP CONSTRAINT "daily_ai_usage_counts_check";--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_plan_id_plans_id_fk";--> statement-breakpoint
DROP INDEX "workspaces_plan_id_index";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "plan_id";--> statement-breakpoint
ALTER TABLE "daily_ai_usage" DROP COLUMN "credits";--> statement-breakpoint
ALTER TABLE "daily_ai_usage" ADD CONSTRAINT "daily_ai_usage_counts_check" CHECK (calls >= 0 and input_tokens >= 0 and output_tokens >= 0 and failed_calls >= 0 and latency_ms_sum >= 0 and latency_ms_max >= 0);
