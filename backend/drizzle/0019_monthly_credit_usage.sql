CREATE TABLE "monthly_credit_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"month" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_credit_usage_workspace_month_unique" UNIQUE("workspace_id","month"),
	CONSTRAINT "monthly_credit_usage_month_format" CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "monthly_credit_usage_used_check" CHECK (used >= 0)
);
--> statement-breakpoint
ALTER TABLE "monthly_credit_usage" ADD CONSTRAINT "monthly_credit_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;