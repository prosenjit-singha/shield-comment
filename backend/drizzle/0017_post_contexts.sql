CREATE TABLE "post_contexts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"social_page_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"post_id" text NOT NULL,
	"caption" text,
	"fetched_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_contexts_key_unique" UNIQUE("workspace_id","platform","post_id"),
	CONSTRAINT "post_contexts_platform_check" CHECK (platform in ('FACEBOOK', 'INSTAGRAM')),
	CONSTRAINT "post_contexts_post_id_format" CHECK (post_id ~ '^[0-9]{1,32}(_[0-9]{1,32}){0,2}$'),
	CONSTRAINT "post_contexts_caption_length" CHECK (caption is null or char_length(caption) between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "post_contexts" ADD CONSTRAINT "post_contexts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_contexts" ADD CONSTRAINT "post_contexts_social_page_id_social_pages_id_fk" FOREIGN KEY ("social_page_id") REFERENCES "public"."social_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_contexts_social_page_id_index" ON "post_contexts" USING btree ("social_page_id");