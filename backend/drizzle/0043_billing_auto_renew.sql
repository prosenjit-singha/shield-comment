ALTER TABLE "billing_accounts" ADD COLUMN "auto_renew_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "auto_renew_token" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "auto_renew_term_end" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "auto_renew_attempts" integer;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_auto_renew_marker_check" CHECK (((auto_renew_term_end is null and auto_renew_attempts is null) or (auto_renew_term_end is not null and auto_renew_attempts is not null)) and (auto_renew_attempts is null or auto_renew_attempts in (1, 2)));