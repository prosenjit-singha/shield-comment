ALTER TABLE "daily_comment_stats" DROP CONSTRAINT "daily_comment_stats_counts_check";--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "rule_match" text;--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD COLUMN "rule_matched_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD COLUMN "blocked_keywords" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD COLUMN "block_urls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD COLUMN "block_phone_numbers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD COLUMN "allowed_domains" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD COLUMN "keyword_rule_action" text DEFAULT 'HIDE' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD COLUMN "url_rule_action" text DEFAULT 'HIDE' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD COLUMN "phone_rule_action" text DEFAULT 'HIDE' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_rule_match_length" CHECK (rule_match is null or char_length(rule_match) between 1 and 200);--> statement-breakpoint
ALTER TABLE "daily_comment_stats" ADD CONSTRAINT "daily_comment_stats_counts_check" CHECK (received_count >= 0 and edited_count >= 0 and removed_count >= 0 and classified_count >= 0 and safe_inquiry_count >= 0 and competitor_poach_count >= 0 and scam_phishing_count >= 0 and spam_irrelevant_count >= 0 and abusive_toxic_count >= 0 and rule_matched_count >= 0 and hidden_count >= 0 and unhidden_count >= 0 and deleted_count >= 0 and replied_count >= 0 and skipped_count >= 0 and failed_count >= 0);--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD CONSTRAINT "moderation_policies_blocked_keywords_check" CHECK (cardinality(blocked_keywords) <= 200 and array_position(blocked_keywords, null) is null and (cardinality(blocked_keywords) = 0 or array_to_string(blocked_keywords, E'\n') ~ '^[^\n]{1,50}(\n[^\n]{1,50})*$'));--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD CONSTRAINT "moderation_policies_allowed_domains_check" CHECK (cardinality(allowed_domains) <= 20 and array_position(allowed_domains, null) is null and (cardinality(allowed_domains) = 0 or array_to_string(allowed_domains, E'\n') ~ '^[a-z0-9.-]{1,253}(\n[a-z0-9.-]{1,253})*$'));--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD CONSTRAINT "moderation_policies_keyword_rule_action_check" CHECK (keyword_rule_action in ('HIDE', 'DELETE'));--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD CONSTRAINT "moderation_policies_url_rule_action_check" CHECK (url_rule_action in ('HIDE', 'DELETE'));--> statement-breakpoint
ALTER TABLE "moderation_policies" ADD CONSTRAINT "moderation_policies_phone_rule_action_check" CHECK (phone_rule_action in ('HIDE', 'DELETE'));