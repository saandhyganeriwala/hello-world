ALTER TABLE "users" ADD COLUMN "free_actions_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill: AI actions each person already used in the free workspaces they own (voice transcription isn't an action).
UPDATE "users" SET "free_actions_used" = COALESCE((
  SELECT COUNT(*) FROM "ai_usage" u JOIN "workspaces" w ON w."id" = u."workspace_id"
  WHERE w."created_by" = "users"."id" AND w."plan" = 'free' AND u."label" <> 'transcribe'), 0);
