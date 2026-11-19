CREATE TABLE "subscription_audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"before_subscription_id" uuid,
	"before_plan_id" uuid,
	"before_interval" text,
	"before_status" text,
	"after_subscription_id" uuid NOT NULL,
	"after_plan_id" uuid NOT NULL,
	"after_interval" text NOT NULL,
	"after_status" text NOT NULL,
	"reason" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_audit_logs_before_check" CHECK ((before_subscription_id is null and before_plan_id is null and before_interval is null and before_status is null) or (before_subscription_id is not null and before_plan_id is not null and before_interval is not null and before_status is not null)),
	CONSTRAINT "subscription_audit_logs_interval_check" CHECK (after_interval in ('month', 'year') and (before_interval is null or before_interval in ('month', 'year'))),
	CONSTRAINT "subscription_audit_logs_status_check" CHECK (after_status in ('TRIALING', 'ACTIVE', 'EXPIRED', 'CANCELED') and (before_status is null or before_status in ('TRIALING', 'ACTIVE', 'EXPIRED', 'CANCELED'))),
	CONSTRAINT "subscription_audit_logs_reason_length" CHECK (char_length(reason) between 1 and 500),
	CONSTRAINT "subscription_audit_logs_ip_address_length" CHECK (ip_address is null or char_length(ip_address) between 1 and 45),
	CONSTRAINT "subscription_audit_logs_user_agent_length" CHECK (user_agent is null or char_length(user_agent) between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "subscription_audit_logs" ADD CONSTRAINT "subscription_audit_logs_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_audit_logs" ADD CONSTRAINT "subscription_audit_logs_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_audit_logs" ADD CONSTRAINT "subscription_audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_audit_logs" ADD CONSTRAINT "subscription_audit_logs_before_subscription_id_subscriptions_id_fk" FOREIGN KEY ("before_subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_audit_logs" ADD CONSTRAINT "subscription_audit_logs_before_plan_id_plans_id_fk" FOREIGN KEY ("before_plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_audit_logs" ADD CONSTRAINT "subscription_audit_logs_after_subscription_id_subscriptions_id_fk" FOREIGN KEY ("after_subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_audit_logs" ADD CONSTRAINT "subscription_audit_logs_after_plan_id_plans_id_fk" FOREIGN KEY ("after_plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_audit_logs_billing_account_id_created_at_index" ON "subscription_audit_logs" USING btree ("billing_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subscription_audit_logs_admin_id_index" ON "subscription_audit_logs" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "subscription_audit_logs_workspace_id_index" ON "subscription_audit_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "subscription_audit_logs_after_subscription_id_index" ON "subscription_audit_logs" USING btree ("after_subscription_id");--> statement-breakpoint
CREATE INDEX "subscription_audit_logs_before_subscription_id_index" ON "subscription_audit_logs" USING btree ("before_subscription_id") WHERE "subscription_audit_logs"."before_subscription_id" is not null;