CREATE TABLE "page_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visitor" text NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"referrer" text,
	"utm_source" text,
	"country" text,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "page_views_time_idx" ON "page_views" USING btree ("created_at");