CREATE TABLE "action_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"action" text NOT NULL,
	"digest_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"company" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_via" text,
	"message_id_header" text,
	"append_uid" bigint,
	"subject" text,
	"html" text,
	"text" text,
	"sections" jsonb,
	"late" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"pipeline_version" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"error_class" text,
	"error" text,
	"requested_model" text,
	"model" text,
	"stop_reason" text,
	"request" jsonb,
	"handle_map" jsonb,
	"output" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_state" (
	"key" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_alert_at" timestamp with time zone,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "mailbox_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"delimiter" text,
	"role" text DEFAULT 'other' NOT NULL,
	"special_use" text,
	"role_source" text DEFAULT 'name' NOT NULL,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"uid_validity" bigint,
	"uid_next" bigint,
	"last_seen_uid" bigint DEFAULT 0 NOT NULL,
	"first_sync_done" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'imap' NOT NULL,
	"address" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"display_name" text,
	"imap_host" text,
	"imap_port" integer DEFAULT 993 NOT NULL,
	"imap_username" text,
	"smtp_host" text,
	"smtp_port" integer DEFAULT 587,
	"credentials_sealed" text,
	"credentials_kid" text,
	"ingest_token_hash" text,
	"status" text DEFAULT 'setup' NOT NULL,
	"status_reason" text,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"backfill_from" timestamp with time zone,
	"live_since" timestamp with time zone,
	"ai_paused" boolean DEFAULT false NOT NULL,
	"ai_paused_reason" text,
	"ai_daily_call_cap" integer,
	"ai_daily_usd_cap" real,
	"probe" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"labeled_by" uuid,
	"sample_week" text,
	"stratum" text,
	"expected" jsonb NOT NULL,
	"verdict" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"uid" bigint NOT NULL,
	"internal_date" timestamp with time zone,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"thread_id" uuid,
	"message_key" text NOT NULL,
	"message_id_header" text,
	"direction" text NOT NULL,
	"from_address" text,
	"from_name" text,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"subject_norm" text DEFAULT '' NOT NULL,
	"date_header" timestamp with time zone,
	"internal_date" timestamp with time zone,
	"sort_ts" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"thread_index" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calendar" jsonb,
	"bounce" jsonb,
	"text_plain" text,
	"text_html" text,
	"body_purged_at" timestamp with time zone,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"classification" text,
	"filter_reason" text,
	"state" text DEFAULT 'discovered' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"late" boolean DEFAULT false NOT NULL,
	"claims_owner_sender" boolean DEFAULT false NOT NULL,
	"has_delivery_trace" boolean DEFAULT false NOT NULL,
	"decode_warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"backfill" boolean DEFAULT false NOT NULL,
	"applied_extraction_id" uuid,
	"via" text DEFAULT 'imap' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Athens' NOT NULL,
	"internal_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"holy_spirit_holiday" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"event" text NOT NULL,
	"detail" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"mfa_verified" boolean DEFAULT false NOT NULL,
	"csrf_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"user_id" uuid,
	"mailbox_id" uuid,
	"message_id" uuid,
	"thread_id" uuid,
	"extraction_id" uuid,
	"op_index" integer,
	"actor" text NOT NULL,
	"op" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"payload" jsonb,
	"evidence_source" text,
	"evidence_quote" text,
	"evidence_norm" text,
	"features" jsonb,
	"tier" text,
	"applied" boolean DEFAULT false NOT NULL,
	"suggestion_state" text,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"thread_id" uuid,
	"message_id" uuid,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mailbox_id" uuid,
	"ref" integer NOT NULL,
	"owner_kind" text DEFAULT 'ME' NOT NULL,
	"owner_address" text,
	"owner_name" text,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"priority" text DEFAULT 'NORMAL' NOT NULL,
	"counterparty_address" text,
	"counterparty_name" text,
	"company" text,
	"company_domain" text,
	"items" text[] DEFAULT '{}'::text[] NOT NULL,
	"due_date" date,
	"due_phrase" text,
	"due_kind" text,
	"expect_reply_by" date,
	"waiting_since" timestamp with time zone,
	"snoozed_until" date,
	"snooze_mode" text,
	"next_action" text,
	"summary" text,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"locked_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"merged_into_id" uuid,
	"origin" text NOT NULL,
	"origin_message_id" uuid,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"auto_closed_reported_at" timestamp with time zone,
	"still_valid_asked_at" timestamp with time zone,
	"dormant_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"subject_norm" text DEFAULT '' NOT NULL,
	"conversation_key" text,
	"merged_into_id" uuid,
	"link_confidence" text DEFAULT 'HIGH' NOT NULL,
	"first_message_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trusted_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"password_hash" text,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"digest_time" text DEFAULT '07:30' NOT NULL,
	"digest_delivery" text DEFAULT 'append' NOT NULL,
	"digest_mailbox_id" uuid,
	"digest_start_date" date,
	"locale" text DEFAULT 'el' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_domains" ADD CONSTRAINT "company_domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD CONSTRAINT "mailbox_folders_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_login_attempts" ADD CONSTRAINT "mailbox_login_attempts_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_locations" ADD CONSTRAINT "message_locations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_locations" ADD CONSTRAINT "message_locations_folder_id_mailbox_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."mailbox_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_domains_uq" ON "company_domains" USING btree ("org_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "digests_user_date_uq" ON "digests" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_msg_version_attempt_uq" ON "extractions" USING btree ("message_id","pipeline_version","attempt");--> statement-breakpoint
CREATE INDEX "extractions_mb_created" ON "extractions" USING btree ("mailbox_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_folders_path_uq" ON "mailbox_folders" USING btree ("mailbox_id","path");--> statement-breakpoint
CREATE INDEX "mailbox_login_attempts_mb_at" ON "mailbox_login_attempts" USING btree ("mailbox_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_user_address_uq" ON "mailboxes" USING btree ("user_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "message_locations_folder_uid_uq" ON "message_locations" USING btree ("folder_id","uid");--> statement-breakpoint
CREATE INDEX "message_locations_msg" ON "message_locations" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_mb_key_uq" ON "messages" USING btree ("mailbox_id","message_key");--> statement-breakpoint
CREATE INDEX "messages_queue" ON "messages" USING btree ("mailbox_id","state","sort_ts");--> statement-breakpoint
CREATE INDEX "messages_mb_msgid" ON "messages" USING btree ("mailbox_id","message_id_header");--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" USING btree ("thread_id","sort_ts");--> statement-breakpoint
CREATE INDEX "security_audit_created" ON "security_audit" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_events_extraction_op_uq" ON "task_events" USING btree ("extraction_id","op_index");--> statement-breakpoint
CREATE INDEX "task_events_task" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_events_pending" ON "task_events" USING btree ("user_id") WHERE "task_events"."suggestion_state" = 'pending';--> statement-breakpoint
CREATE INDEX "task_events_thread_neg" ON "task_events" USING btree ("thread_id","op");--> statement-breakpoint
CREATE UNIQUE INDEX "task_links_uq" ON "task_links" USING btree ("task_id","message_id","role");--> statement-breakpoint
CREATE INDEX "task_links_thread" ON "task_links" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "task_links_message" ON "task_links" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_user_ref_uq" ON "tasks" USING btree ("user_id","ref");--> statement-breakpoint
CREATE INDEX "tasks_user_open" ON "tasks" USING btree ("user_id","status") WHERE "tasks"."status" in ('ACTION_REQUIRED','WAITING_FOR_ME','WAITING_FOR_OTHER') and "tasks"."merged_into_id" is null;--> statement-breakpoint
CREATE INDEX "tasks_mb_counterparty" ON "tasks" USING btree ("mailbox_id",lower("counterparty_address")) WHERE "tasks"."status" in ('ACTION_REQUIRED','WAITING_FOR_ME','WAITING_FOR_OTHER');--> statement-breakpoint
CREATE INDEX "tasks_mb_company_domain" ON "tasks" USING btree ("mailbox_id","company_domain");--> statement-breakpoint
CREATE INDEX "tasks_search" ON "tasks" USING gin (to_tsvector('simple', "search_text"));--> statement-breakpoint
CREATE INDEX "threads_mb_conv" ON "threads" USING btree ("mailbox_id","conversation_key");--> statement-breakpoint
CREATE INDEX "threads_mb_subject" ON "threads" USING btree ("mailbox_id","subject_norm");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));