CREATE TABLE "meta_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"facebook_user_id" text NOT NULL,
	"encrypted_user_access_token" text NOT NULL,
	"token_expires_at" timestamp (3) with time zone,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"status_changed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_connections_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "meta_connections_status_check" CHECK (status in ('ACTIVE', 'NEEDS_REAUTH', 'REVOKED')),
	CONSTRAINT "meta_connections_facebook_user_id_format" CHECK (facebook_user_id ~ '^[0-9]{1,32}$'),
	CONSTRAINT "meta_connections_user_token_format" CHECK (encrypted_user_access_token ~ '^v[0-9]+:')
);
--> statement-breakpoint
CREATE TABLE "social_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" text NOT NULL,
	"page_name" text NOT NULL,
	"ig_business_id" text,
	"ig_username" text,
	"encrypted_page_access_token" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_pages_page_id_unique" UNIQUE("page_id"),
	CONSTRAINT "social_pages_ig_business_id_unique" UNIQUE("ig_business_id"),
	CONSTRAINT "social_pages_page_id_format" CHECK (page_id ~ '^[0-9]{1,32}$'),
	CONSTRAINT "social_pages_ig_business_id_format" CHECK (ig_business_id is null or ig_business_id ~ '^[0-9]{1,32}$'),
	CONSTRAINT "social_pages_ig_username_needs_ig_id" CHECK ("social_pages"."ig_username" is null or "social_pages"."ig_business_id" is not null),
	CONSTRAINT "social_pages_page_token_format" CHECK (encrypted_page_access_token is null or encrypted_page_access_token ~ '^v[0-9]+:'),
	CONSTRAINT "social_pages_active_needs_token" CHECK (not "social_pages"."is_active" or "social_pages"."encrypted_page_access_token" is not null)
);
--> statement-breakpoint
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_pages" ADD CONSTRAINT "social_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meta_connections_facebook_user_id_index" ON "meta_connections" USING btree ("facebook_user_id");--> statement-breakpoint
CREATE INDEX "social_pages_workspace_id_index" ON "social_pages" USING btree ("workspace_id");