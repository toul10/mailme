ALTER TABLE "users" ADD COLUMN "important_senders" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "muted_senders" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "cc_policy" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_note" text;