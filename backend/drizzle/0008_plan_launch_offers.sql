-- Launch offers on the paid plans (M2-T15, user decision 2026-11-18): the pricing card shows the
-- original price struck through next to the offer price. Values + badges from
-- docs/design/client.md §7: Starter ~~৳999~~ ৳499 "50% Launch Offer", Growth ~~৳2,499~~ ৳1,499
-- "40% Off", Pro ("Agency" column) ~~৳5,999~~ ৳3,999 "33% Off". Free stays ৳0 with no offer.
-- Customers keep paying the same amount (the old list price becomes the offer price).
--
-- Guarded + idempotent: a plan is only touched while it still carries exactly the values seeded by
-- 0007_seed_plans (slug + original price + no offer + no badge), so a plan an admin has already
-- edited in A7 is left alone, and running this again matches nothing.
-- No plan_audit_logs row: this is a data migration, not an admin edit.
UPDATE "plans" AS p
SET "original_price_bdt" = v."original_price_bdt",
	"offer_price_bdt" = v."offer_price_bdt",
	"offer_badge" = v."offer_badge",
	"updated_at" = now()
FROM (VALUES
	('starter', 499, 999, 499, '50% Launch Offer'),
	('growth', 1499, 2499, 1499, '40% Off'),
	('pro', 3999, 5999, 3999, '33% Off')
) AS v ("slug", "seeded_price_bdt", "original_price_bdt", "offer_price_bdt", "offer_badge")
WHERE p."slug" = v."slug"
	AND p."original_price_bdt" = v."seeded_price_bdt"
	AND p."offer_price_bdt" IS NULL
	AND p."offer_badge" IS NULL;
