CREATE TABLE "meta_data_deletion_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"confirmation_code" text NOT NULL,
	"facebook_user_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_data_deletion_requests_confirmation_code_unique" UNIQUE("confirmation_code"),
	CONSTRAINT "meta_data_deletion_requests_status_check" CHECK (status in ('PENDING', 'COMPLETED')),
	CONSTRAINT "meta_data_deletion_requests_code_format" CHECK ("meta_data_deletion_requests"."confirmation_code" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "meta_data_deletion_requests_facebook_user_id_format" CHECK ("meta_data_deletion_requests"."facebook_user_id" ~ '^[0-9]{1,32}$'),
	CONSTRAINT "meta_data_deletion_requests_completed_at_check" CHECK (("meta_data_deletion_requests"."status" = 'COMPLETED') = ("meta_data_deletion_requests"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "meta_connections" DROP CONSTRAINT "meta_connections_user_token_format";--> statement-breakpoint
ALTER TABLE "meta_connections" ALTER COLUMN "encrypted_user_access_token" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_data_deletion_requests_one_pending_unique" ON "meta_data_deletion_requests" USING btree ("facebook_user_id") WHERE "meta_data_deletion_requests"."status" = 'PENDING';--> statement-breakpoint
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_token_unless_revoked" CHECK ("meta_connections"."encrypted_user_access_token" is not null or "meta_connections"."status" = 'REVOKED');--> statement-breakpoint
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_user_token_format" CHECK (encrypted_user_access_token is null or encrypted_user_access_token ~ '^v[0-9]+:');