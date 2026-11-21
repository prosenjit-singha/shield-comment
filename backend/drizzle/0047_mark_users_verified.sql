-- M9-T5 (D10 b, M9-T5-a): sign-in now requires a verified email. Every account that exists before
-- this rule signed up without one, so it counts as verified (data only, no schema change).
UPDATE "users" SET "email_verified" = true WHERE "email_verified" = false;
