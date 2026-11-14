ALTER TABLE "users" ADD COLUMN "platform_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "setup_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "setup_expires_at" timestamp with time zone;