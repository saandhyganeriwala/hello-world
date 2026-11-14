ALTER TABLE "ai_usage" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;