CREATE SEQUENCE "public"."payment_invoice_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tran_id" text,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_source_check" CHECK (source in ('IPN', 'SUCCESS', 'FAIL', 'CANCEL')),
	CONSTRAINT "payment_events_outcome_check" CHECK (outcome ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "payment_events_tran_id_check" CHECK (tran_id is null or char_length(tran_id) between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"plan_id" uuid NOT NULL,
	"interval" text NOT NULL,
	"kind" text NOT NULL,
	"tran_id" text NOT NULL,
	"amount_bdt" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"gateway" text NOT NULL,
	"val_id" text,
	"bank_tran_id" text,
	"card_type" text,
	"risk_level" integer,
	"paid_at" timestamp (3) with time zone,
	"subscription_id" uuid,
	"price" jsonb NOT NULL,
	"invoice_number" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transactions_tranId_unique" UNIQUE("tran_id"),
	CONSTRAINT "payment_transactions_invoiceNumber_unique" UNIQUE("invoice_number"),
	CONSTRAINT "payment_transactions_interval_check" CHECK ("interval" in ('month', 'year')),
	CONSTRAINT "payment_transactions_kind_check" CHECK (kind in ('NEW', 'RENEWAL', 'UPGRADE')),
	CONSTRAINT "payment_transactions_status_check" CHECK (status in ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED')),
	CONSTRAINT "payment_transactions_gateway_check" CHECK (gateway in ('SSLCOMMERZ', 'PROMOTION')),
	CONSTRAINT "payment_transactions_tran_id_check" CHECK (tran_id ~ '^[A-Za-z0-9_-]{8,30}$'),
	CONSTRAINT "payment_transactions_invoice_number_check" CHECK (invoice_number is null or invoice_number ~ '^SC-[0-9]{4}-[0-9]{5,}$'),
	CONSTRAINT "payment_transactions_amounts_check" CHECK (amount_bdt >= 0 and (risk_level is null or risk_level >= 0)),
	CONSTRAINT "payment_transactions_promotion_check" CHECK (gateway <> 'PROMOTION' or (amount_bdt = 0 and val_id is null)),
	CONSTRAINT "payment_transactions_price_check" CHECK (jsonb_typeof(price) = 'object'),
	CONSTRAINT "payment_transactions_settled_check" CHECK (((status in ('PAID', 'REFUNDED')) = (paid_at is not null)) and ((paid_at is null and invoice_number is null and subscription_id is null) or (paid_at is not null and invoice_number is not null and subscription_id is not null)) and (paid_at is null or gateway = 'PROMOTION' or val_id is not null))
);
--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_tran_id_index" ON "payment_events" USING btree ("tran_id");--> statement-breakpoint
CREATE INDEX "payment_events_source_received_at_index" ON "payment_events" USING btree ("source","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_transactions_billing_account_id_created_at_index" ON "payment_transactions" USING btree ("billing_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_transactions_status_created_at_index" ON "payment_transactions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payment_transactions_created_at_index" ON "payment_transactions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_transactions_workspace_id_index" ON "payment_transactions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "payment_transactions_plan_id_index" ON "payment_transactions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "payment_transactions_user_id_index" ON "payment_transactions" USING btree ("user_id") WHERE "payment_transactions"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_transactions_subscription_id_index" ON "payment_transactions" USING btree ("subscription_id") WHERE "payment_transactions"."subscription_id" is not null;