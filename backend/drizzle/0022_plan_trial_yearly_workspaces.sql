-- Plan data for subscriptions, trial and wallet (PW-T1b; user decisions 2026-11-19 PW-D1, PW-D5,
-- PW-D7, PW-D8, PW-D10, PW-D12, PW-D13). Data only (the columns come from 0021).
--
-- Idempotent and admin edits are kept: every statement only fills what is still missing, so a
-- second run matches nothing. `updated_at` is not touched and no `plan_audit_logs` row is written:
-- this is a data migration, not an admin edit (like 0018).

-- 1. AI credits are dropped → monthly comments (PW-D1): `limits.monthlyAiCredits` (0018) goes back
--    to `limits.monthlyComments`, the number is copied as it is (seeds 500 / 2,500 / 15,000 / 75,000
--    or an admin's edit). If a plan already has `monthlyComments`, that value wins. Old key removed.
UPDATE "plans"
SET "feature_config" = jsonb_set(
	"feature_config",
	'{limits}',
	(("feature_config" -> 'limits') - 'monthlyAiCredits')
		|| jsonb_build_object(
			'monthlyComments',
			coalesce(("feature_config" -> 'limits') -> 'monthlyComments', ("feature_config" -> 'limits') -> 'monthlyAiCredits')
		)
)
WHERE jsonb_typeof("feature_config" -> 'limits') = 'object'
	AND ("feature_config" -> 'limits') ? 'monthlyAiCredits';
--> statement-breakpoint

-- 2. Workspace limit per plan (PW-D10): Starter 1 · Growth 3 · Pro 10 (Free 1: it is deactivated
--    below and only kept for history). Only where the key is missing.
UPDATE "plans" AS p
SET "feature_config" = jsonb_set(
	p."feature_config",
	'{limits}',
	(p."feature_config" -> 'limits') || jsonb_build_object('workspaces', v."workspaces")
)
FROM (VALUES
	('free', 1),
	('starter', 1),
	('growth', 3),
	('pro', 10)
) AS v ("slug", "workspaces")
WHERE p."slug" = v."slug"
	AND jsonb_typeof(p."feature_config" -> 'limits') = 'object'
	AND NOT ((p."feature_config" -> 'limits') ? 'workspaces');
--> statement-breakpoint

-- 3. Starter trial (PW-D8 7 days, PW-D12 300 comments): only while still null.
UPDATE "plans" SET "trial_days" = 7
WHERE "slug" = 'starter' AND "trial_days" IS NULL;
--> statement-breakpoint
UPDATE "plans" SET "trial_comment_limit" = 300
WHERE "slug" = 'starter' AND "trial_comment_limit" IS NULL;
--> statement-breakpoint

-- 4. Yearly per-month prices (PW-D13: 10% off the monthly price, rounded down): only while still
--    null, and only when the figure is ≤ the plan's monthly price (`offer ?? original`, the
--    `plans_yearly_monthly_price_check` rule): a plan whose monthly price an admin lowered below it
--    gets no yearly price (the admin sets one in A7).
UPDATE "plans" AS p
SET "yearly_monthly_price_bdt" = v."price"
FROM (VALUES
	('starter', 449),
	('growth', 1349),
	('pro', 3599)
) AS v ("slug", "price")
WHERE p."slug" = v."slug"
	AND p."yearly_monthly_price_bdt" IS NULL
	AND v."price" <= coalesce(p."offer_price_bdt", p."original_price_bdt");
--> statement-breakpoint

-- 5. No Free plan (PW-D7): the row stays for audit history but is no longer offered.
UPDATE "plans" SET "is_active" = false
WHERE "slug" = 'free' AND "is_active";
