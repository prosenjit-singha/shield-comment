CREATE TABLE "workspace_status_audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"old_status" "workspace_status" NOT NULL,
	"new_status" "workspace_status" NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_status_audit_logs_status_changed" CHECK ("workspace_status_audit_logs"."old_status" <> "workspace_status_audit_logs"."new_status"),
	CONSTRAINT "workspace_status_audit_logs_reason_length" CHECK (char_length(reason) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "workspace_status_audit_logs" ADD CONSTRAINT "workspace_status_audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_status_audit_logs" ADD CONSTRAINT "workspace_status_audit_logs_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_status_audit_logs_workspace_id_index" ON "workspace_status_audit_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_status_audit_logs_admin_id_index" ON "workspace_status_audit_logs" USING btree ("admin_id");