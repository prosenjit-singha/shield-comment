CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"original_price_bdt" integer NOT NULL,
	"offer_price_bdt" integer,
	"offer_badge" text,
	"feature_config" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_slug_unique" UNIQUE("slug"),
	CONSTRAINT "plans_name_unique" UNIQUE("name"),
	CONSTRAINT "plans_slug_format" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "plans_name_length" CHECK (char_length(name) between 1 and 40),
	CONSTRAINT "plans_original_price_check" CHECK (original_price_bdt >= 0),
	CONSTRAINT "plans_offer_price_check" CHECK (offer_price_bdt is null or (offer_price_bdt >= 0 and offer_price_bdt <= original_price_bdt)),
	CONSTRAINT "plans_offer_badge_length" CHECK (offer_badge is null or char_length(offer_badge) between 1 and 40),
	CONSTRAINT "plans_feature_config_object" CHECK (jsonb_typeof(feature_config) = 'object')
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspaces_plan_id_index" ON "workspaces" USING btree ("plan_id");