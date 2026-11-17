CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_role" text NOT NULL,
	"body" text NOT NULL,
	"is_internal_note" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_messages_sender_role_check" CHECK (sender_role in ('ADMIN', 'CLIENT')),
	CONSTRAINT "ticket_messages_body_length" CHECK (char_length(body) between 1 and 5000),
	CONSTRAINT "ticket_messages_internal_note_admin_only" CHECK (not is_internal_note or sender_role = 'ADMIN')
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"category" text NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_category_check" CHECK (category in ('BILLING', 'TECHNICAL', 'ACCOUNT', 'OTHER')),
	CONSTRAINT "tickets_priority_check" CHECK (priority in ('LOW', 'MEDIUM', 'HIGH')),
	CONSTRAINT "tickets_status_check" CHECK (status in ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
	CONSTRAINT "tickets_subject_length" CHECK (char_length(subject) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_id_created_at_index" ON "ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_messages_sender_id_index" ON "ticket_messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "tickets_created_at_index" ON "tickets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tickets_workspace_id_created_at_index" ON "tickets" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "tickets_status_created_at_index" ON "tickets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tickets_priority_created_at_index" ON "tickets" USING btree ("priority","created_at");--> statement-breakpoint
CREATE INDEX "tickets_category_created_at_index" ON "tickets" USING btree ("category","created_at");--> statement-breakpoint
CREATE INDEX "tickets_user_id_index" ON "tickets" USING btree ("user_id");