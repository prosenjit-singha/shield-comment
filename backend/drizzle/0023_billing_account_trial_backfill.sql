-- Billing accounts + a fresh Starter trial for existing clients (PW-T3; user decisions 2026-11-19
-- PW-D8 Starter trial once per account, PW-D12 trial comment limit, PW-D15 "the migration gives
-- each existing client account a fresh Starter trial"; plan §3.8 step 3). Data only (the tables
-- come from 0021, the trial values from 0022).
--
-- Idempotent: every statement only fills what is still missing (unlinked workspaces, accounts
-- without any subscription row), so a second run matches nothing. Workspace `updated_at` is not
-- touched. Ids are UUIDv7 like the app's (`src/db/schema/columns.ts`): Postgres 17 has no
-- `uuidv7()`, so they are built from `gen_random_uuid()` with the millisecond clock in the first
-- 48 bits and the version nibble set to 7.

-- 1. One billing account per payer user: each unlinked workspace's oldest owner, else its oldest
--    member (ties: lowest user id). A member-less workspace has no payer and stays unlinked
--    (`billing_account_id` null = no live plan). Existing accounts are kept.
INSERT INTO "billing_accounts" ("id", "owner_user_id")
SELECT
	encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
	"payers"."user_id"
FROM (
	SELECT DISTINCT "payer"."user_id"
	FROM (
		SELECT DISTINCT ON (m."workspace_id") m."workspace_id", m."user_id"
		FROM "workspace_members" m
		JOIN "workspaces" w ON w."id" = m."workspace_id"
		WHERE w."billing_account_id" IS NULL
		ORDER BY m."workspace_id", (m."role" = 'owner') DESC, m."created_at", m."user_id"
	) AS "payer"
) AS "payers"
ON CONFLICT ("owner_user_id") DO NOTHING;
--> statement-breakpoint

-- 2. Link every unlinked workspace to its payer's account (same payer rule as step 1).
UPDATE "workspaces" AS w
SET "billing_account_id" = a."id"
FROM (
	SELECT DISTINCT ON (m."workspace_id") m."workspace_id", m."user_id"
	FROM "workspace_members" m
	JOIN "workspaces" x ON x."id" = m."workspace_id"
	WHERE x."billing_account_id" IS NULL
	ORDER BY m."workspace_id", (m."role" = 'owner') DESC, m."created_at", m."user_id"
) AS "payer"
JOIN "billing_accounts" a ON a."owner_user_id" = "payer"."user_id"
WHERE w."id" = "payer"."workspace_id"
	AND w."billing_account_id" IS NULL;
--> statement-breakpoint

-- 3. A fresh Starter trial for every account **without any subscription row** (PW-D15; trial once
--    per account), exactly like `SubscriptionService.startTrial` + `WalletService` write it:
--    - `subscriptions`: TRIALING, interval `month`, `started_at = current_term_start` = migration
--      time (ms), `trial_ends_at = current_term_end` = + `trial_days` × 24 h (exact, any session time
--      zone; same as `trialEndsAt()`), no prices;
--    - `wallets`: anchor = period start = `started_at`, period end = trial end;
--    - `wallet_balances`: `monthlyComments` for that period, `included` =
--      `coalesce(trial_comment_limit, limits.monthlyComments)` (PW-D12; a missing / non-integer
--      limit reads as 0 like `normalizeFeatureConfig`);
--    - `wallet_entries`: one `PLAN_GRANT` of that amount, `reference` = the subscription id.
--    `trial_days` / `trial_comment_limit` are read from the active `starter` row now; no row or
--    `trial_days` null = no trials (nothing written). One statement, so the four inserts see each
--    other only through RETURNING.
WITH "starter" AS (
	SELECT
		p."id",
		p."trial_days",
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
		) AS "grant"
	FROM "plans" p
	WHERE p."slug" = 'starter' AND p."is_active" AND p."trial_days" IS NOT NULL
),
"clock" AS (
	SELECT date_trunc('milliseconds', now()) AS "at"
),
"subs" AS (
	INSERT INTO "subscriptions" (
		"id", "billing_account_id", "plan_id", "interval", "status",
		"started_at", "trial_ends_at", "current_term_start", "current_term_end"
	)
	SELECT
		encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
		a."id",
		s."id",
		'month',
		'TRIALING',
		c."at",
		c."at" + s."trial_days" * interval '24 hours',
		c."at",
		c."at" + s."trial_days" * interval '24 hours'
	FROM "billing_accounts" a
	CROSS JOIN "starter" s
	CROSS JOIN "clock" c
	WHERE NOT EXISTS (
		SELECT 1 FROM "subscriptions" x WHERE x."billing_account_id" = a."id"
	)
	ON CONFLICT DO NOTHING
	RETURNING "id", "billing_account_id", "started_at", "current_term_end"
),
"opened" AS (
	INSERT INTO "wallets" (
		"id", "billing_account_id", "cycle_anchor_at", "current_period_start", "current_period_end"
	)
	SELECT
		encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
		"subs"."billing_account_id",
		"subs"."started_at",
		"subs"."started_at",
		"subs"."current_term_end"
	FROM "subs"
	ON CONFLICT ("billing_account_id") DO UPDATE SET
		"cycle_anchor_at" = excluded."cycle_anchor_at",
		"current_period_start" = excluded."current_period_start",
		"current_period_end" = excluded."current_period_end",
		"updated_at" = now()
	RETURNING "id", "billing_account_id"
),
"granted" AS (
	INSERT INTO "wallet_balances" (
		"id", "wallet_id", "meter", "period_start", "period_end", "included"
	)
	SELECT
		encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3) FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid,
		o."id",
		'monthlyComments',
		s."started_at",
		s."current_term_end",
		st."grant"
	FROM "opened" o
	JOIN "subs" s ON s."billing_account_id" = o."billing_account_id"
	CROSS JOIN "starter" st
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
JOIN "opened" o ON o."id" = g."wallet_id"
JOIN "subs" s ON s."billing_account_id" = o."billing_account_id";
