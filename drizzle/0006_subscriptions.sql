CREATE TABLE "razorpay_plans" (
	"key" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"subscription_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"current_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_subscription_id_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "renews_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_workspace_idx" ON "subscriptions" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_id_unique" UNIQUE("payment_id");