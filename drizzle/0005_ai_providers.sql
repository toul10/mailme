CREATE TABLE "ai_providers" (
	"provider" text PRIMARY KEY NOT NULL,
	"key_sealed" text,
	"key_last4" text,
	"key_set_by" uuid,
	"key_set_at" timestamp with time zone,
	"env_last4" text,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"models_listed_at" timestamp with time zone,
	"models_from" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"provider" text,
	"model" text,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"worker_report" jsonb,
	"worker_report_at" timestamp with time zone
);
