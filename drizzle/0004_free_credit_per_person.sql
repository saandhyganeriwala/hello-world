ALTER TABLE "users" ADD COLUMN "free_spent_inr" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "bonus_inr" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill: what each person already spent in the free workspaces they own.
UPDATE "users" SET "free_spent_inr" = COALESCE((
  SELECT SUM(u."cost_inr") FROM "ai_usage" u JOIN "workspaces" w ON w."id" = u."workspace_id"
  WHERE w."created_by" = "users"."id" AND w."plan" = 'free'), 0);
