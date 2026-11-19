CREATE TABLE "billing_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_owner_user_id_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"interval" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"trial_ends_at" timestamp (3) with time zone,
	"current_term_start" timestamp (3) with time zone NOT NULL,
	"current_term_end" timestamp (3) with time zone NOT NULL,
	"price_per_month_bdt" integer,
	"charged_bdt" integer,
	"canceled_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_interval_check" CHECK ("interval" in ('month', 'year')),
	CONSTRAINT "subscriptions_status_check" CHECK (status in ('TRIALING', 'ACTIVE', 'EXPIRED', 'CANCELED')),
	CONSTRAINT "subscriptions_term_check" CHECK (current_term_end > current_term_start),
	CONSTRAINT "subscriptions_trial_ends_at_check" CHECK (trial_ends_at is null or trial_ends_at > started_at),
	CONSTRAINT "subscriptions_prices_check" CHECK (((price_per_month_bdt is null and charged_bdt is null) or (price_per_month_bdt is not null and charged_bdt is not null)) and (price_per_month_bdt is null or price_per_month_bdt >= 0 and charged_bdt >= 0)),
	CONSTRAINT "subscriptions_trialing_check" CHECK (status <> 'TRIALING' or (trial_ends_at is not null and current_term_end = trial_ends_at and price_per_month_bdt is null)),
	CONSTRAINT "subscriptions_active_check" CHECK (status <> 'ACTIVE' or price_per_month_bdt is not null),
	CONSTRAINT "subscriptions_canceled_at_check" CHECK ((status = 'CANCELED') = (canceled_at is not null))
);
--> statement-breakpoint
CREATE TABLE "wallet_balances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet_id" uuid NOT NULL,
	"meter" text NOT NULL,
	"period_start" timestamp (3) with time zone NOT NULL,
	"period_end" timestamp (3) with time zone NOT NULL,
	"included" integer NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_balances_wallet_meter_period_unique" UNIQUE("wallet_id","meter","period_start"),
	CONSTRAINT "wallet_balances_meter_format" CHECK (meter ~ '^[a-z][A-Za-z0-9]{0,63}$'),
	CONSTRAINT "wallet_balances_period_check" CHECK (period_end > period_start),
	CONSTRAINT "wallet_balances_amounts_check" CHECK (included >= 0 and added >= 0 and used >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet_id" uuid NOT NULL,
	"meter" text NOT NULL,
	"period_start" timestamp (3) with time zone NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"reference" text,
	"actor_user_id" uuid,
	"note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_entries_meter_format" CHECK (meter ~ '^[a-z][A-Za-z0-9]{0,63}$'),
	CONSTRAINT "wallet_entries_kind_check" CHECK (kind in ('PLAN_GRANT', 'ADJUSTMENT', 'TOP_UP', 'EXPIRE')),
	CONSTRAINT "wallet_entries_amount_check" CHECK ((kind <> 'PLAN_GRANT' or amount >= 0) and (kind <> 'TOP_UP' or amount > 0) and (kind <> 'EXPIRE' or amount <= 0) and (kind <> 'ADJUSTMENT' or amount <> 0)),
	CONSTRAINT "wallet_entries_reference_length" CHECK (reference is null or char_length(reference) between 1 and 200),
	CONSTRAINT "wallet_entries_note_length" CHECK (note is null or char_length(note) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"cycle_anchor_at" timestamp (3) with time zone NOT NULL,
	"current_period_start" timestamp (3) with time zone NOT NULL,
	"current_period_end" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_billing_account_id_unique" UNIQUE("billing_account_id"),
	CONSTRAINT "wallets_period_check" CHECK (current_period_end > current_period_start)
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "yearly_monthly_price_bdt" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "trial_days" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "trial_comment_limit" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_account_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "usage_counted_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_balances" ADD CONSTRAINT "wallet_balances_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_billing_account_id_created_at_index" ON "subscriptions" USING btree ("billing_account_id","created_at");--> statement-breakpoint
CREATE INDEX "subscriptions_plan_id_index" ON "subscriptions" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_live_per_account" ON "subscriptions" USING btree ("billing_account_id") WHERE status in ('TRIALING', 'ACTIVE');--> statement-breakpoint
CREATE INDEX "subscriptions_live_term_end_index" ON "subscriptions" USING btree ("current_term_end") WHERE status in ('TRIALING', 'ACTIVE');--> statement-breakpoint
CREATE INDEX "wallet_entries_wallet_id_created_at_index" ON "wallet_entries" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_entries_actor_user_id_index" ON "wallet_entries" USING btree ("actor_user_id") WHERE "wallet_entries"."actor_user_id" is not null;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspaces_billing_account_id_index" ON "workspaces" USING btree ("billing_account_id");--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_yearly_monthly_price_check" CHECK (yearly_monthly_price_bdt is null or (yearly_monthly_price_bdt >= 0 and yearly_monthly_price_bdt <= coalesce(offer_price_bdt, original_price_bdt)));--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_trial_days_check" CHECK (trial_days is null or trial_days between 1 and 90);--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_trial_comment_limit_check" CHECK (trial_comment_limit is null or trial_comment_limit between 0 and 10000000);