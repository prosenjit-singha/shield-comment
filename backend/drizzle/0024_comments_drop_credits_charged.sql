-- PW-T4 (PW-D1/D2): comments are counted once against the monthly comment limit (`usage_counted_at`).
-- A comment already charged AI credits before this release counts as counted, so its later edits stay free.
UPDATE "comments" SET "usage_counted_at" = coalesce("classified_at", "updated_at") WHERE "usage_counted_at" IS NULL AND "credits_charged" > 0;--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_credits_charged_check";--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN "credits_charged";
