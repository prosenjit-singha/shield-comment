ALTER TABLE "ai_settings_audit_logs" DROP CONSTRAINT "ai_settings_audit_logs_field_check";--> statement-breakpoint
ALTER TABLE "ai_settings_audit_logs" DROP CONSTRAINT "ai_settings_audit_logs_values_check";--> statement-breakpoint
ALTER TABLE "ai_provider_settings" ADD COLUMN "text_image_model" text;--> statement-breakpoint
ALTER TABLE "ai_provider_settings" ADD COLUMN "text_image_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_provider_settings" ADD CONSTRAINT "ai_provider_settings_text_image_model_length" CHECK (text_image_model is null or char_length(text_image_model) between 1 and 100);--> statement-breakpoint
ALTER TABLE "ai_settings_audit_logs" ADD CONSTRAINT "ai_settings_audit_logs_field_check" CHECK (field in ('provider', 'model', 'text_image_model', 'text_image_enabled', 'key.neon', 'key.openai', 'key.anthropic', 'key.google'));--> statement-breakpoint
ALTER TABLE "ai_settings_audit_logs" ADD CONSTRAINT "ai_settings_audit_logs_values_check" CHECK (case
          when field = 'provider' then (before is null or before in ('neon', 'openai', 'anthropic', 'google')) and (after is null or after in ('neon', 'openai', 'anthropic', 'google'))
          when field in ('model', 'text_image_model') then (before is null or char_length(before) between 1 and 100) and (after is null or char_length(after) between 1 and 100)
          when field = 'text_image_enabled' then before in ('true', 'false') and after in ('true', 'false')
          when field in ('key.neon', 'key.openai', 'key.anthropic', 'key.google') then (before is null or before = 'set') and after in ('set', 'cleared')
          else false
        end);