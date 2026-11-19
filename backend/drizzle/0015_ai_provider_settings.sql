CREATE TABLE "ai_provider_keys" (
	"provider" text PRIMARY KEY NOT NULL,
	"key_ciphertext" text NOT NULL,
	"last4" text NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_keys_provider_check" CHECK (provider in ('neon', 'openai', 'anthropic', 'google')),
	CONSTRAINT "ai_provider_keys_ciphertext_format" CHECK ("ai_provider_keys"."key_ciphertext" ~ '^v[0-9]+:'),
	CONSTRAINT "ai_provider_keys_last4_length" CHECK (char_length("ai_provider_keys"."last4") = 4)
);
--> statement-breakpoint
CREATE TABLE "ai_provider_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"provider" text,
	"model" text,
	"updated_by_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_settings_singleton" CHECK ("ai_provider_settings"."id" = 1),
	CONSTRAINT "ai_provider_settings_provider_check" CHECK (provider is null or provider in ('neon', 'openai', 'anthropic', 'google')),
	CONSTRAINT "ai_provider_settings_model_length" CHECK (model is null or char_length(model) between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "ai_settings_audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"field" text NOT NULL,
	"before" text,
	"after" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_audit_logs_field_check" CHECK (field in ('provider', 'model', 'key.neon', 'key.openai', 'key.anthropic', 'key.google')),
	CONSTRAINT "ai_settings_audit_logs_values_check" CHECK (case
          when field = 'provider' then (before is null or before in ('neon', 'openai', 'anthropic', 'google')) and (after is null or after in ('neon', 'openai', 'anthropic', 'google'))
          when field = 'model' then (before is null or char_length(before) between 1 and 100) and (after is null or char_length(after) between 1 and 100)
          when field in ('key.neon', 'key.openai', 'key.anthropic', 'key.google') then (before is null or before = 'set') and after in ('set', 'cleared')
          else false
        end),
	CONSTRAINT "ai_settings_audit_logs_ip_address_length" CHECK (ip_address is null or char_length(ip_address) between 1 and 45),
	CONSTRAINT "ai_settings_audit_logs_user_agent_length" CHECK (user_agent is null or char_length(user_agent) between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "ai_provider_keys" ADD CONSTRAINT "ai_provider_keys_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_settings" ADD CONSTRAINT "ai_provider_settings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings_audit_logs" ADD CONSTRAINT "ai_settings_audit_logs_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_settings_audit_logs_created_at_index" ON "ai_settings_audit_logs" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_settings_audit_logs_admin_id_index" ON "ai_settings_audit_logs" USING btree ("admin_id");