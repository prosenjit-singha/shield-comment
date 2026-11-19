CREATE TABLE "daily_ai_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"credits" bigint DEFAULT 0 NOT NULL,
	"failed_calls" integer DEFAULT 0 NOT NULL,
	"failures_by_kind" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms_sum" bigint DEFAULT 0 NOT NULL,
	"latency_ms_max" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_ai_usage_key_unique" UNIQUE("day","provider","model"),
	CONSTRAINT "daily_ai_usage_provider_check" CHECK (provider in ('neon', 'openai', 'anthropic', 'google')),
	CONSTRAINT "daily_ai_usage_model_length" CHECK (char_length(model) between 1 and 100),
	CONSTRAINT "daily_ai_usage_counts_check" CHECK (calls >= 0 and input_tokens >= 0 and output_tokens >= 0 and credits >= 0 and failed_calls >= 0 and latency_ms_sum >= 0 and latency_ms_max >= 0),
	CONSTRAINT "daily_ai_usage_failed_calls_check" CHECK ("daily_ai_usage"."failed_calls" <= "daily_ai_usage"."calls"),
	CONSTRAINT "daily_ai_usage_failures_by_kind_check" CHECK (jsonb_typeof("daily_ai_usage"."failures_by_kind") = 'object')
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"user_id" uuid,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"error_kind" text,
	"reply_comment_id" text,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_actions_action_check" CHECK (action in ('HIDE', 'UNHIDE', 'DELETE', 'REPLY')),
	CONSTRAINT "moderation_actions_source_check" CHECK (source in ('AUTO', 'USER')),
	CONSTRAINT "moderation_actions_state_check" CHECK (state in ('PENDING', 'SUCCEEDED', 'FAILED')),
	CONSTRAINT "moderation_actions_auto_has_no_user" CHECK (source = 'USER' or user_id is null),
	CONSTRAINT "moderation_actions_error_kind_check" CHECK ((state = 'FAILED') = (error_kind is not null) and (error_kind is null or error_kind ~ '^[a-z][a-z0-9_]{0,63}$')),
	CONSTRAINT "moderation_actions_completed_at_check" CHECK ((state = 'PENDING') = (completed_at is null)),
	CONSTRAINT "moderation_actions_reply_comment_id_check" CHECK (reply_comment_id is null or (action = 'REPLY' and state = 'SUCCEEDED' and reply_comment_id ~ '^[0-9]{1,32}(_[0-9]{1,32}){0,2}$'))
);
--> statement-breakpoint
CREATE TABLE "moderation_policies" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'AUTO' NOT NULL,
	"confidence_threshold" numeric(4, 3) DEFAULT 0.8 NOT NULL,
	"ai_context_level" text DEFAULT 'comment_only' NOT NULL,
	"safe_inquiry_action" text DEFAULT 'NONE' NOT NULL,
	"safe_inquiry_auto_reply" boolean DEFAULT false NOT NULL,
	"safe_inquiry_reply_en" text,
	"safe_inquiry_reply_bn" text,
	"competitor_poach_action" text DEFAULT 'HIDE' NOT NULL,
	"competitor_poach_auto_reply" boolean DEFAULT false NOT NULL,
	"competitor_poach_reply_en" text,
	"competitor_poach_reply_bn" text,
	"scam_phishing_action" text DEFAULT 'HIDE' NOT NULL,
	"scam_phishing_auto_reply" boolean DEFAULT false NOT NULL,
	"scam_phishing_reply_en" text,
	"scam_phishing_reply_bn" text,
	"spam_irrelevant_action" text DEFAULT 'HIDE' NOT NULL,
	"spam_irrelevant_auto_reply" boolean DEFAULT false NOT NULL,
	"spam_irrelevant_reply_en" text,
	"spam_irrelevant_reply_bn" text,
	"abusive_toxic_action" text DEFAULT 'HIDE' NOT NULL,
	"abusive_toxic_auto_reply" boolean DEFAULT false NOT NULL,
	"abusive_toxic_reply_en" text,
	"abusive_toxic_reply_bn" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_policies_mode_check" CHECK (mode in ('AUTO', 'REVIEW')),
	CONSTRAINT "moderation_policies_threshold_range" CHECK ("moderation_policies"."confidence_threshold" between 0 and 1),
	CONSTRAINT "moderation_policies_ai_context_level_check" CHECK (ai_context_level in ('comment_only', 'page_name', 'post_caption')),
	CONSTRAINT "moderation_policies_safe_inquiry_action_check" CHECK (safe_inquiry_action in ('NONE', 'HIDE', 'DELETE')),
	CONSTRAINT "moderation_policies_safe_inquiry_reply_check" CHECK ((not safe_inquiry_auto_reply or (safe_inquiry_reply_en is not null and safe_inquiry_reply_bn is not null)) and (safe_inquiry_reply_en is null or char_length(safe_inquiry_reply_en) between 1 and 500) and (safe_inquiry_reply_bn is null or char_length(safe_inquiry_reply_bn) between 1 and 500)),
	CONSTRAINT "moderation_policies_competitor_poach_action_check" CHECK (competitor_poach_action in ('NONE', 'HIDE', 'DELETE')),
	CONSTRAINT "moderation_policies_competitor_poach_reply_check" CHECK ((not competitor_poach_auto_reply or (competitor_poach_reply_en is not null and competitor_poach_reply_bn is not null)) and (competitor_poach_reply_en is null or char_length(competitor_poach_reply_en) between 1 and 500) and (competitor_poach_reply_bn is null or char_length(competitor_poach_reply_bn) between 1 and 500)),
	CONSTRAINT "moderation_policies_scam_phishing_action_check" CHECK (scam_phishing_action in ('NONE', 'HIDE', 'DELETE')),
	CONSTRAINT "moderation_policies_scam_phishing_reply_check" CHECK ((not scam_phishing_auto_reply or (scam_phishing_reply_en is not null and scam_phishing_reply_bn is not null)) and (scam_phishing_reply_en is null or char_length(scam_phishing_reply_en) between 1 and 500) and (scam_phishing_reply_bn is null or char_length(scam_phishing_reply_bn) between 1 and 500)),
	CONSTRAINT "moderation_policies_spam_irrelevant_action_check" CHECK (spam_irrelevant_action in ('NONE', 'HIDE', 'DELETE')),
	CONSTRAINT "moderation_policies_spam_irrelevant_reply_check" CHECK ((not spam_irrelevant_auto_reply or (spam_irrelevant_reply_en is not null and spam_irrelevant_reply_bn is not null)) and (spam_irrelevant_reply_en is null or char_length(spam_irrelevant_reply_en) between 1 and 500) and (spam_irrelevant_reply_bn is null or char_length(spam_irrelevant_reply_bn) between 1 and 500)),
	CONSTRAINT "moderation_policies_abusive_toxic_action_check" CHECK (abusive_toxic_action in ('NONE', 'HIDE', 'DELETE')),
	CONSTRAINT "moderation_policies_abusive_toxic_reply_check" CHECK ((not abusive_toxic_auto_reply or (abusive_toxic_reply_en is not null and abusive_toxic_reply_bn is not null)) and (abusive_toxic_reply_en is null or char_length(abusive_toxic_reply_en) between 1 and 500) and (abusive_toxic_reply_bn is null or char_length(abusive_toxic_reply_bn) between 1 and 500))
);
--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_status_check";--> statement-breakpoint
ALTER TABLE "daily_comment_stats" DROP CONSTRAINT "daily_comment_stats_counts_check";--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "confidence" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "reasoning" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "classified_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "ai_provider" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "context_level" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "credits_charged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "overridden_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "classified_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "safe_inquiry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "competitor_poach_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "scam_phishing_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "spam_irrelevant_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "abusive_toxic_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "hidden_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "unhidden_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "deleted_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "replied_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "skipped_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD CONSTRAINT "moderation_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_actions_workspace_id_created_at_index" ON "moderation_actions" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "moderation_actions_comment_id_created_at_index" ON "moderation_actions" USING btree ("comment_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_user_id_index" ON "moderation_actions" USING btree ("user_id") WHERE "moderation_actions"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_actions_one_auto_reply" ON "moderation_actions" USING btree ("comment_id") WHERE action = 'REPLY' and source = 'AUTO';--> statement-breakpoint
CREATE INDEX "comments_moderation_retry_index" ON "comments" USING btree ("created_at") WHERE status in ('PENDING', 'FAILED');--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_category_check" CHECK (category is null or category in ('SAFE_INQUIRY', 'COMPETITOR_POACH', 'SCAM_PHISHING', 'SPAM_IRRELEVANT', 'ABUSIVE_TOXIC'));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_confidence_range" CHECK (confidence is null or confidence between 0 and 1);--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_reasoning_check" CHECK (reasoning is null or (category is not null and char_length(reasoning) between 0 and 280));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_language_check" CHECK (language is null or language in ('bn', 'banglish', 'en'));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_ai_provider_check" CHECK (ai_provider is null or ai_provider in ('neon', 'openai', 'anthropic', 'google'));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_model_length" CHECK (model is null or char_length(model) between 1 and 100);--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_prompt_version_format" CHECK (prompt_version is null or prompt_version ~ '^[a-z0-9][a-z0-9._-]{0,49}$');--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_context_level_check" CHECK (context_level is null or context_level in ('comment_only', 'page_name', 'post_caption'));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_classification_complete" CHECK ((category is null and confidence is null and language is null and classified_at is null and ai_provider is null and model is null and prompt_version is null and context_level is null) or (category is not null and confidence is not null and language is not null and classified_at is not null and ai_provider is not null and model is not null and prompt_version is not null and context_level is not null));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_credits_charged_check" CHECK ("comments"."credits_charged" >= 0);--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_status_reason_format" CHECK (status_reason is null or status_reason ~ '^[a-z][a-z0-9_]{0,63}$');--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_status_check" CHECK (status in ('PENDING', 'VISIBLE', 'NEEDS_REVIEW', 'HIDDEN', 'DELETED', 'SKIPPED', 'FAILED'));--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD CONSTRAINT "daily_comment_stats_counts_check" CHECK (received_count >= 0 and edited_count >= 0 and removed_count >= 0 and classified_count >= 0 and safe_inquiry_count >= 0 and competitor_poach_count >= 0 and scam_phishing_count >= 0 and spam_irrelevant_count >= 0 and abusive_toxic_count >= 0 and hidden_count >= 0 and unhidden_count >= 0 and deleted_count >= 0 and replied_count >= 0 and skipped_count >= 0 and failed_count >= 0);