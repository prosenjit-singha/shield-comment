-- M9-T4 (D4 a): the 7 audit tables are append-only. UPDATE, DELETE and TRUNCATE raise SQLSTATE
-- P0001 `audit_log_immutable`. Exceptions: the one-time impersonation burn (`used_at` null → value;
-- `updated_at` may move with it, every other column unchanged) and test cleanups that run
-- `SET LOCAL shield.audit_maintenance = 'on'` inside their transaction (app code never sets it).
CREATE FUNCTION "forbid_audit_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF current_setting('shield.audit_maintenance', true) = 'on' THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;
	IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'impersonation_audit_logs' THEN
		IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL
			AND to_jsonb(NEW) - 'used_at' - 'updated_at' = to_jsonb(OLD) - 'used_at' - 'updated_at' THEN
			RETURN NEW;
		END IF;
	END IF;
	RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'audit_log_immutable',
		DETAIL = format('%s on %s', TG_OP, TG_TABLE_NAME);
END
$$;
--> statement-breakpoint
CREATE TRIGGER "impersonation_audit_logs_immutable" BEFORE UPDATE OR DELETE ON "impersonation_audit_logs" FOR EACH ROW EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "impersonation_audit_logs_no_truncate" BEFORE TRUNCATE ON "impersonation_audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "workspace_status_audit_logs_immutable" BEFORE UPDATE OR DELETE ON "workspace_status_audit_logs" FOR EACH ROW EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "workspace_status_audit_logs_no_truncate" BEFORE TRUNCATE ON "workspace_status_audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "plan_audit_logs_immutable" BEFORE UPDATE OR DELETE ON "plan_audit_logs" FOR EACH ROW EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "plan_audit_logs_no_truncate" BEFORE TRUNCATE ON "plan_audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "ai_settings_audit_logs_immutable" BEFORE UPDATE OR DELETE ON "ai_settings_audit_logs" FOR EACH ROW EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "ai_settings_audit_logs_no_truncate" BEFORE TRUNCATE ON "ai_settings_audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "ai_credit_topup_audit_logs_immutable" BEFORE UPDATE OR DELETE ON "ai_credit_topup_audit_logs" FOR EACH ROW EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "ai_credit_topup_audit_logs_no_truncate" BEFORE TRUNCATE ON "ai_credit_topup_audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "subscription_audit_logs_immutable" BEFORE UPDATE OR DELETE ON "subscription_audit_logs" FOR EACH ROW EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "subscription_audit_logs_no_truncate" BEFORE TRUNCATE ON "subscription_audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "payment_refunds_immutable" BEFORE UPDATE OR DELETE ON "payment_refunds" FOR EACH ROW EXECUTE FUNCTION "forbid_audit_change"();--> statement-breakpoint
CREATE TRIGGER "payment_refunds_no_truncate" BEFORE TRUNCATE ON "payment_refunds" FOR EACH STATEMENT EXECUTE FUNCTION "forbid_audit_change"();
