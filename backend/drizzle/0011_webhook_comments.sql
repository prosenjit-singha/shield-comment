CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"comment_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"social_page_id" uuid,
	"platform" text NOT NULL,
	"post_id" text NOT NULL,
	"author_id" text,
	"author_name" text,
	"message" text,
	"raw_payload" jsonb,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"edited_at" timestamp (3) with time zone,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_comment_id_unique" UNIQUE("comment_id"),
	CONSTRAINT "comments_platform_check" CHECK (platform in ('FACEBOOK', 'INSTAGRAM')),
	CONSTRAINT "comments_status_check" CHECK (status in ('PENDING')),
	CONSTRAINT "comments_comment_id_format" CHECK (comment_id ~ '^[0-9]{1,32}(_[0-9]{1,32}){0,2}$'),
	CONSTRAINT "comments_post_id_format" CHECK (post_id ~ '^[0-9]{1,32}(_[0-9]{1,32}){0,2}$'),
	CONSTRAINT "comments_author_id_format" CHECK (author_id is null or author_id ~ '^[0-9]{1,32}$')
);
--> statement-breakpoint
CREATE TABLE "daily_comment_stats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" text NOT NULL,
	"platform" text NOT NULL,
	"day" date NOT NULL,
	"received_count" integer DEFAULT 0 NOT NULL,
	"edited_count" integer DEFAULT 0 NOT NULL,
	"removed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_comment_stats_key_unique" UNIQUE("workspace_id","page_id","platform","day"),
	CONSTRAINT "daily_comment_stats_page_id_format" CHECK (page_id ~ '^[0-9]{1,32}$'),
	CONSTRAINT "daily_comment_stats_platform_check" CHECK (platform in ('FACEBOOK', 'INSTAGRAM')),
	CONSTRAINT "daily_comment_stats_counts_check" CHECK ("daily_comment_stats"."received_count" >= 0 and "daily_comment_stats"."edited_count" >= 0 and "daily_comment_stats"."removed_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"processed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "webhook_events_event_id_format" CHECK (event_id ~ '^(FACEBOOK|INSTAGRAM):[0-9_]+:(add|edited|remove)$'),
	CONSTRAINT "webhook_events_payload_hash_format" CHECK ("webhook_events"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_social_page_id_social_pages_id_fk" FOREIGN KEY ("social_page_id") REFERENCES "public"."social_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD CONSTRAINT "daily_comment_stats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_workspace_id_created_at_index" ON "comments" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comments_social_page_id_index" ON "comments" USING btree ("social_page_id");--> statement-breakpoint
CREATE INDEX "comments_raw_payload_purge_index" ON "comments" USING btree ("created_at") WHERE "comments"."raw_payload" is not null;--> statement-breakpoint
CREATE INDEX "webhook_events_workspace_id_created_at_index" ON "webhook_events" USING btree ("workspace_id","created_at" DESC NULLS LAST);