CREATE TABLE "ai_credit_topup_audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"action" text NOT NULL,
	"topup_id" uuid NOT NULL,
	"amount_usd" numeric(10, 2) NOT NULL,
	"topped_up_on" date NOT NULL,
	"note" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credit_topup_audit_logs_action_check" CHECK (action in ('add', 'delete')),
	CONSTRAINT "ai_credit_topup_audit_logs_ip_address_length" CHECK (ip_address is null or char_length(ip_address) between 1 and 45),
	CONSTRAINT "ai_credit_topup_audit_logs_user_agent_length" CHECK (user_agent is null or char_length(user_agent) between 1 and 512)
);
--> statement-breakpoint
CREATE TABLE "ai_credit_topups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"amount_usd" numeric(10, 2) NOT NULL,
	"topped_up_on" date NOT NULL,
	"note" text,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credit_topups_amount_positive" CHECK ("ai_credit_topups"."amount_usd" > 0),
	CONSTRAINT "ai_credit_topups_note_length" CHECK (note is null or char_length(note) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "ai_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "ai_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "ai_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_credit_topup_audit_logs" ADD CONSTRAINT "ai_credit_topup_audit_logs_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_topups" ADD CONSTRAINT "ai_credit_topups_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_credit_topup_audit_logs_admin_id_index" ON "ai_credit_topup_audit_logs" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "ai_credit_topup_audit_logs_topup_id_index" ON "ai_credit_topup_audit_logs" USING btree ("topup_id");--> statement-breakpoint
CREATE INDEX "ai_credit_topups_created_by_id_index" ON "ai_credit_topups" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "comments_classified_at_index" ON "comments" USING btree ("classified_at" DESC NULLS LAST) WHERE "comments"."classified_at" is not null;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_ai_usage_check" CHECK ((ai_input_tokens is null or ai_input_tokens >= 0) and (ai_output_tokens is null or ai_output_tokens >= 0) and (ai_latency_ms is null or ai_latency_ms >= 0));