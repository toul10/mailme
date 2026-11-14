#!/usr/bin/env bash
# One-time infrastructure, no application data yet: APIs, the image repository, service accounts, Cloud SQL with the
# database and its user (the URL with a random password goes straight into Secret Manager), IAM, and the exclusion
# that keeps the API's request logs out of Cloud Logging. Idempotent: what exists is left alone.
#
# BILLABLE from here on: Cloud SQL db-f1-micro + 10 GB HDD ≈ $8.6/month while it exists (README § Costs).
set -euo pipefail
source "$(dirname "$0")/config.sh"

cat <<EOF
Project $PROJECT, region $REGION. This creates (what exists is skipped):
  - APIs: Cloud Run, Cloud SQL Admin, Cloud Scheduler, Artifact Registry, Secret Manager, Cloud Build
  - Artifact Registry repository "$AR_REPO" (keeps the 5 newest images)
  - service accounts $SA_API, $SA_WORKER, $SA_SCHEDULER (+ Cloud SQL client role for the first two)
  - Cloud SQL "$SQL_INSTANCE": PostgreSQL 16, Enterprise, $SQL_TIER, 10 GB HDD, daily backups (7) + point-in-time
    recovery, maintenance Sunday 02:00 UTC, deletion protection — about \$8.6/month
  - database "$DB_NAME", user "$DB_USER" with a random password, stored only as secret "$SECRET_DB_URL"
  - a _Default log-sink exclusion for $API_SERVICE's request logs (one-click links carry a token in the URL)
EOF
confirm "Create them?" || exit 1

note "APIs"
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com iam.googleapis.com \
  --project "$PROJECT"

note "Artifact Registry"
if ! gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" --project "$PROJECT" --quiet >/dev/null 2>&1; then
  gcloud artifacts repositories create "$AR_REPO" --repository-format docker --location "$REGION" \
    --description "MailMe images, tagged with the git commit" --project "$PROJECT"
fi
policy="$(mktemp)"
trap 'rm -f "$policy"' EXIT
cat >"$policy" <<'EOF'
[
  { "name": "keep-newest-5", "action": { "type": "Keep" }, "mostRecentVersions": { "keepCount": 5 } },
  { "name": "delete-older-than-30d", "action": { "type": "Delete" }, "condition": { "tagState": "any", "olderThan": "30d" } }
]
EOF
gcloud artifacts repositories set-cleanup-policies "$AR_REPO" --location "$REGION" --policy "$policy" --project "$PROJECT" >/dev/null

note "Service accounts"
for sa in "$SA_API" "$SA_WORKER" "$SA_SCHEDULER"; do
  exists_sa "$sa" || gcloud iam service-accounts create "$sa" --display-name "MailMe ${sa#mailme-}" --project "$PROJECT"
done
for sa in "$SA_API" "$SA_WORKER"; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$(sa_email "$sa")" \
    --role roles/cloudsql.client --condition None --quiet >/dev/null
  echo "  roles/cloudsql.client → $sa"
done

note "Cloud SQL (creating an instance takes about 10 minutes)"
if ! exists_sql; then
  gcloud sql instances create "$SQL_INSTANCE" --project "$PROJECT" --region "$REGION" \
    --database-version POSTGRES_16 --edition enterprise --tier "$SQL_TIER" \
    --storage-type HDD --storage-size 10 --storage-auto-increase --availability-type zonal \
    --backup-start-time 01:00 --retained-backups-count 7 --enable-point-in-time-recovery \
    --maintenance-window-day SUN --maintenance-window-hour 2 --deletion-protection
fi
if ! gcloud sql databases describe "$DB_NAME" --instance "$SQL_INSTANCE" --project "$PROJECT" --quiet >/dev/null 2>&1; then
  gcloud sql databases create "$DB_NAME" --instance "$SQL_INSTANCE" --project "$PROJECT"
fi

note "Database user and $SECRET_DB_URL"
if exists_secret "$SECRET_DB_URL"; then
  echo "  $SECRET_DB_URL exists: user and password left as they are"
else
  # Hex: nothing to URL-encode. gcloud takes the password as an argument (visible in `ps` for a few seconds).
  pass="$(openssl rand -hex 24)"
  if gcloud sql users list --instance "$SQL_INSTANCE" --project "$PROJECT" --format='value(name)' | grep -qx "$DB_USER"; then
    gcloud sql users set-password "$DB_USER" --instance "$SQL_INSTANCE" --password "$pass" --project "$PROJECT"
  else
    gcloud sql users create "$DB_USER" --instance "$SQL_INSTANCE" --password "$pass" --project "$PROJECT"
  fi
  # @localhost keeps it a valid URL for `new URL()` (backup:dump); node-postgres connects through ?host=, the socket
  # Cloud Run mounts for --set-cloudsql-instances.
  printf 'postgres://%s:%s@localhost/%s?host=/cloudsql/%s' "$DB_USER" "$pass" "$DB_NAME" "$(sql_connection)" |
    gcloud secrets create "$SECRET_DB_URL" --data-file=- --replication-policy user-managed --locations "$REGION" \
      --project "$PROJECT" >/dev/null
  unset pass
  echo "  $SECRET_DB_URL created"
fi

note "Request-log exclusion"
filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$API_SERVICE\" AND log_id(\"run.googleapis.com/requests\")"
if gcloud logging sinks describe _Default --project "$PROJECT" --format=json | grep -q '"name": "mailme-api-requests"'; then
  echo "  exists"
else
  gcloud logging sinks update _Default --project "$PROJECT" \
    --add-exclusion "name=mailme-api-requests,description=MailMe one-click report links carry a signed token in the URL path,filter=$filter"
fi

note "Done. Next: deploy/gcp/20-secrets.sh"
