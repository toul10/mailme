ALTER TABLE "messages" ADD COLUMN "filter_rule" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mail_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;