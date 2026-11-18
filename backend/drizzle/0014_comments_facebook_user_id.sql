ALTER TABLE "comments" ADD COLUMN "facebook_user_id" text;--> statement-breakpoint
CREATE INDEX "comments_facebook_user_id_index" ON "comments" USING btree ("facebook_user_id") WHERE "comments"."facebook_user_id" is not null;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_facebook_user_id_format" CHECK (facebook_user_id is null or facebook_user_id ~ '^[0-9]{1,32}$');