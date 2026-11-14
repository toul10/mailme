ALTER TABLE "digests" ADD COLUMN "rendered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD COLUMN "failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "failure_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
CREATE INDEX "messages_bounce_original" ON "messages" USING btree ("mailbox_id",("bounce" ->> 'originalMessageId')) WHERE "messages"."filter_reason" = 'BOUNCE';