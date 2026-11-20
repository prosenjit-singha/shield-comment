CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"scam_count" integer NOT NULL,
	"error_kind" text,
	"sent_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_deliveries_channel_check" CHECK (channel in ('EMAIL', 'TELEGRAM')),
	CONSTRAINT "alert_deliveries_status_check" CHECK (status in ('SENT', 'FAILED')),
	CONSTRAINT "alert_deliveries_scam_count_check" CHECK (scam_count >= 0),
	CONSTRAINT "alert_deliveries_error_kind_check" CHECK ((status = 'FAILED') = (error_kind is not null))
);
--> statement-breakpoint
CREATE TABLE "alert_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"spike_threshold" integer DEFAULT 10 NOT NULL,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"email_recipient_member_ids" uuid[],
	"telegram_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_settings_spike_threshold_check" CHECK (spike_threshold between 1 and 1000),
	CONSTRAINT "alert_settings_email_recipient_member_ids_check" CHECK (cardinality(email_recipient_member_ids) <= 10)
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_settings" ADD CONSTRAINT "alert_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_deliveries_workspace_id_sent_at_index" ON "alert_deliveries" USING btree ("workspace_id","sent_at" DESC NULLS LAST);