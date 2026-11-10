ALTER TABLE "workspaces" ADD COLUMN "invite_code" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_invite_code_unique" UNIQUE("invite_code");