ALTER TABLE "comments" ADD COLUMN "moderation_stage" text;--> statement-breakpoint
-- M5-T12 backfill: comments stored before the worker existed still owe a classification.
UPDATE "comments" SET "moderation_stage" = 'classify' WHERE "status" = 'PENDING' AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "comments_moderation_stage_index" ON "comments" USING btree (coalesce("edited_at", "created_at")) WHERE "comments"."moderation_stage" is not null;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_moderation_stage_check" CHECK (moderation_stage is null or moderation_stage in ('classify', 'act'));