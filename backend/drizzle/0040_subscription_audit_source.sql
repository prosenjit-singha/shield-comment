ALTER TABLE "subscription_audit_logs" ALTER COLUMN "admin_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_audit_logs" ADD COLUMN "source" text DEFAULT 'ADMIN' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_audit_logs" ADD CONSTRAINT "subscription_audit_logs_source_check" CHECK (source in ('ADMIN', 'PAYMENT') and ((source = 'ADMIN') = (admin_id is not null)));