-- Seed the four plan tiers (M2-T11, user decision 2026-11-18). Monthly BDT list prices:
-- Free ৳0, Starter ৳499, Growth ৳1,499, Pro ৳3,999. No offer/badge seeded (set them in A7).
-- Limits/flags follow the landing pricing matrix (docs/design/client.md §7; Pro = its "Agency"
-- column, Free = Starter with 500 comments). Fixed UUIDv7 ids keep plans identical in every
-- environment. ON CONFLICT DO NOTHING: never overwrites a plan an admin has already edited.
INSERT INTO "plans" ("id", "slug", "name", "sort_order", "is_active", "original_price_bdt", "offer_price_bdt", "offer_badge", "feature_config") VALUES
	('01a1ecf3-2bc1-7e91-a0e8-d51b5fe0c781', 'free', 'Free', 0, true, 0, NULL, NULL,
		'{"limits":{"connectedPages":1,"monthlyComments":500,"teamSeats":1},"features":{"banglaAiFilter":true,"autoHideScams":true,"customBlocklist":false,"autoReplyTemplates":false,"messengerAlerts":false,"whiteLabelReports":false,"prioritySupportApi":false}}'::jsonb),
	('01a1ecf3-2bc3-798d-b4f7-aa6a8a6fd983', 'starter', 'Starter', 1, true, 499, NULL, NULL,
		'{"limits":{"connectedPages":1,"monthlyComments":2500,"teamSeats":1},"features":{"banglaAiFilter":true,"autoHideScams":true,"customBlocklist":false,"autoReplyTemplates":false,"messengerAlerts":false,"whiteLabelReports":false,"prioritySupportApi":false}}'::jsonb),
	('01a1ecf3-2bc3-798d-b4f7-aa6b28d1f2db', 'growth', 'Growth', 2, true, 1499, NULL, NULL,
		'{"limits":{"connectedPages":5,"monthlyComments":15000,"teamSeats":3},"features":{"banglaAiFilter":true,"autoHideScams":true,"customBlocklist":true,"autoReplyTemplates":true,"messengerAlerts":true,"whiteLabelReports":false,"prioritySupportApi":false}}'::jsonb),
	('01a1ecf3-2bc3-798d-b4f7-aa6cf077a148', 'pro', 'Pro', 3, true, 3999, NULL, NULL,
		'{"limits":{"connectedPages":25,"monthlyComments":75000,"teamSeats":10},"features":{"banglaAiFilter":true,"autoHideScams":true,"customBlocklist":true,"autoReplyTemplates":true,"messengerAlerts":true,"whiteLabelReports":true,"prioritySupportApi":true}}'::jsonb)
ON CONFLICT ("slug") DO NOTHING;
