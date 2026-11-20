CREATE TABLE "telegram_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"linked_by_user_id" uuid,
	"linked_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_chats_workspace_chat_unique" UNIQUE("workspace_id","telegram_chat_id"),
	CONSTRAINT "telegram_chats_type_check" CHECK (type in ('private', 'group', 'supergroup'))
);
--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_linked_by_user_id_users_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;