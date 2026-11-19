-- Monthly AI credits replace the monthly comment limit (Module 5 D15, M5-T11; user decision
-- 2026-11-19): each plan's `feature_config.limits.monthlyComments` number becomes
-- `limits.monthlyAiCredits` (seed values 500 / 2,500 / 15,000 / 75,000; a number an admin has
-- already edited in A7 is copied as it is). The old key is removed, so this runs once per plan:
-- a second run matches nothing. If a plan already has `monthlyAiCredits`, that value is kept
-- (the new key wins, like `normalizeFeatureConfig`). `updated_at` is not touched (same value,
-- new name) and no `plan_audit_logs` row is written: this is a data migration, not an admin edit.
UPDATE "plans"
SET "feature_config" = jsonb_set(
	"feature_config",
	'{limits}',
	(("feature_config" -> 'limits') - 'monthlyComments')
		|| jsonb_build_object(
			'monthlyAiCredits',
			coalesce(("feature_config" -> 'limits') -> 'monthlyAiCredits', ("feature_config" -> 'limits') -> 'monthlyComments')
		)
)
WHERE jsonb_typeof("feature_config" -> 'limits') = 'object'
	AND ("feature_config" -> 'limits') ? 'monthlyComments';
