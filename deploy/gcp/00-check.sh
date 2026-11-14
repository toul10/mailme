#!/usr/bin/env bash
# Read-only preflight: what exists in the project, what the local setup has. Creates and changes nothing.
set -euo pipefail
source "$(dirname "$0")/config.sh"

ok() { printf '  %-44s %s\n' "$1" "$2"; }
yesno() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }

note "gcloud"
ok "account" "$(gcloud config get-value account 2>/dev/null)"
ok "project (passed explicitly)" "$PROJECT, region $REGION"
ok "global gcloud project (left as is)" "$(gcloud config get-value project 2>/dev/null)"
gcloud projects describe "$PROJECT" >/dev/null 2>&1 || die "no access to project $PROJECT"
ok "project number" "$(project_number)"
ok "billing enabled" "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || echo unknown)"

note "APIs"
enabled="$(gcloud services list --enabled --project "$PROJECT" --format='value(config.name)' 2>/dev/null)"
for api in run.googleapis.com sqladmin.googleapis.com cloudscheduler.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com iam.googleapis.com; do
  ok "$api" "$(grep -qx "$api" <<<"$enabled" && echo enabled || echo 'not enabled (10-setup.sh enables it)')"
done

note "MailMe resources"
api_on() { grep -qx "$1" <<<"$enabled"; }
ok "Artifact Registry repo $AR_REPO" "$(yesno gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" --project "$PROJECT" --quiet)"
for sa in "$SA_API" "$SA_WORKER" "$SA_SCHEDULER"; do ok "service account $sa" "$(yesno exists_sa "$sa")"; done
if api_on sqladmin.googleapis.com; then ok "Cloud SQL $SQL_INSTANCE" "$(yesno exists_sql)"; else ok "Cloud SQL $SQL_INSTANCE" "no (sqladmin not enabled)"; fi
for s in "$SECRET_DB_URL" "$SECRET_MASTER_KEY" "$SECRET_APP_SECRET" "$SECRET_LINK_SECRET" "$SECRET_PUBLIC_KEY" "$SECRET_PRIVATE_KEY" "$SECRET_ANTHROPIC_KEY"; do
  ok "secret $s" "$(yesno exists_secret "$s")"
done
ok "Cloud Run service $API_SERVICE" "$(yesno exists_service "$API_SERVICE")"
ok "Cloud Run job $MIGRATE_JOB" "$(yesno exists_job "$MIGRATE_JOB")"
ok "Cloud Run job $TICK_JOB" "$(yesno exists_job "$TICK_JOB")"
if api_on cloudscheduler.googleapis.com; then
  ok "Scheduler job $SCHEDULER_JOB" "$(if exists_scheduler; then gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" --format='value(state)'; else echo no; fi)"
else
  ok "Scheduler job $SCHEDULER_JOB" "no (cloudscheduler not enabled)"
fi
ok "APP_BASE_URL (public address)" "$(public_url)"
ok "run.app address (health checks)" "$(run_url)"
if [ -n "$MAILME_DOMAIN" ]; then
  apex="${MAILME_DOMAIN#*.}"
  ok "$apex verified for this account" "$(gcloud domains list-user-verified --format='value(id)' 2>/dev/null | grep -qx "$apex" && echo yes || echo 'no: Search Console (deploy/gcp/README.md § Your own address)')"
  ok "domain mapping $MAILME_DOMAIN" "$(st="$(domain_status)"; echo "${st:-no}")"
fi

note "Local"
ok "repo" "$REPO_ROOT"
ok ".env" "$(yesno test -f "$REPO_ROOT/.env")"
ok "credentials public key" "$(f="$(dotenv_path CREDENTIALS_PUBLIC_KEY_FILE)"; [ -n "$f" ] && [ -f "$f" ] && echo present || echo MISSING)"
ok "credentials private key" "$(f="$(dotenv_path CREDENTIALS_PRIVATE_KEY_FILE)"; [ -n "$f" ] && [ -f "$f" ] && echo present || echo MISSING)"
ok "git HEAD" "$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
ok "working tree clean (needed to build)" "$([ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] && echo yes || echo 'no: commit first')"
ok "AI_MODE in .env" "$(m="$(dotenv_get AI_MODE)"; echo "${m:-mock (unset)}")"
ok "cloud-sql-proxy (for CLI commands)" "$(command -v cloud-sql-proxy || echo 'missing: https://cloud.google.com/sql/docs/postgres/sql-proxy')"
