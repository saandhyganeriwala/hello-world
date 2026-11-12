ALTER TABLE "subscriptions" ADD COLUMN "provider" text DEFAULT 'razorpay' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "environment" text;