CREATE TABLE "plan_audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_audit_logs_action_check" CHECK (action in ('UPDATE')),
	CONSTRAINT "plan_audit_logs_changes_check" CHECK (jsonb_typeof("plan_audit_logs"."changes") = 'array' and jsonb_array_length("plan_audit_logs"."changes") > 0),
	CONSTRAINT "plan_audit_logs_ip_address_length" CHECK (ip_address is null or char_length(ip_address) between 1 and 45),
	CONSTRAINT "plan_audit_logs_user_agent_length" CHECK (user_agent is null or char_length(user_agent) between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "plan_audit_logs" ADD CONSTRAINT "plan_audit_logs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_audit_logs" ADD CONSTRAINT "plan_audit_logs_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_audit_logs_plan_id_created_at_index" ON "plan_audit_logs" USING btree ("plan_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "plan_audit_logs_created_at_index" ON "plan_audit_logs" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "plan_audit_logs_admin_id_index" ON "plan_audit_logs" USING btree ("admin_id");