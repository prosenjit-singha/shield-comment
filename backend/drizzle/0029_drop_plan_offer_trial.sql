-- PR-T7: drop the old offer and trial plan columns (PR-D8: plans are fixed facts; offers and
-- trials are promotions since PR-T1).
--
-- Reading (6): a pre-PR-T3 sign-up trial (TRIALING, no `promotion_redemption_id`) keeps its end
-- and comment limit. Its end is `subscriptions.trial_ends_at`; its limit was snapshotted into the
-- trial's one wallet period (`wallet_balances.included`, period start = `started_at`) when the
-- trial started (sign-up tx since PW-T3, or the 0023 backfill), and the wallet keeps a stored row.
-- Steps 1–2 only pin that snapshot for a live pre-PR-T3 trial that has no such row (normally a
-- no-op), exactly like 0023: `coalesce(trial_comment_limit, limits.monthlyComments)`, a missing
-- or non-integer limit reads as 0. Afterwards nothing reads the plan columns.

-- 1. A wallet for every live pre-PR-T3 trial account without one (anchor = period = the trial).
INSERT INTO "wallets" (
	"id", "billing_account_id", "cycle_anchor_at", "current_period_start", "current_period_end"
)
SELECT
	encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
	s."billing_account_id",
	s."started_at",
	s."started_at",
	s."current_term_end"
FROM "subscriptions" s
WHERE s."status" = 'TRIALING'
	AND s."promotion_redemption_id" IS NULL
	AND s."current_term_end" > now()
ON CONFLICT ("billing_account_id") DO NOTHING;
--> statement-breakpoint

-- 2. The trial's `monthlyComments` balance (+ its `PLAN_GRANT` entry) when missing.
WITH "granted" AS (
	INSERT INTO "wallet_balances" (
		"id", "wallet_id", "meter", "period_start", "period_end", "included"
	)
	SELECT
		encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
		w."id",
		'monthlyComments',
		s."started_at",
		s."current_term_end",
		coalesce(
			p."trial_comment_limit",
			CASE
				WHEN jsonb_typeof(p."feature_config" #> '{limits,monthlyComments}') = 'number'
					AND (p."feature_config" #>> '{limits,monthlyComments}')::numeric >= 0
					AND (p."feature_config" #>> '{limits,monthlyComments}')::numeric
						= trunc((p."feature_config" #>> '{limits,monthlyComments}')::numeric)
				THEN (p."feature_config" #>> '{limits,monthlyComments}')::numeric::integer
				ELSE 0
			END
		)
	FROM "subscriptions" s
	JOIN "plans" p ON p."id" = s."plan_id"
	JOIN "wallets" w ON w."billing_account_id" = s."billing_account_id"
	WHERE s."status" = 'TRIALING'
		AND s."promotion_redemption_id" IS NULL
		AND s."current_term_end" > now()
	ON CONFLICT ("wallet_id", "meter", "period_start") DO NOTHING
	RETURNING "wallet_id", "meter", "period_start", "included"
)
INSERT INTO "wallet_entries" (
	"id", "wallet_id", "meter", "period_start", "kind", "amount", "reference"
)
SELECT
	encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
	g."wallet_id",
	g."meter",
	g."period_start",
	'PLAN_GRANT',
	g."included",
	s."id"::text
FROM "granted" g
JOIN "wallets" w ON w."id" = g."wallet_id"
JOIN "subscriptions" s ON s."billing_account_id" = w."billing_account_id"
	AND s."started_at" = g."period_start"
	AND s."status" = 'TRIALING'
	AND s."promotion_redemption_id" IS NULL;
--> statement-breakpoint

-- 3. Drop the columns (generated).
ALTER TABLE "plans" DROP CONSTRAINT "plans_offer_price_check";--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT "plans_offer_badge_length";--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT "plans_trial_days_check";--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT "plans_trial_comment_limit_check";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "offer_price_bdt";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "offer_badge";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "trial_days";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "trial_comment_limit";
