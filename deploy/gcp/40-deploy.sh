#!/usr/bin/env bash
# Release one built image: migrations (Cloud Run job, waited for), then the API service, then the tick job.
# It never starts ticks: 50-schedule.sh creates the schedule once; afterwards a release only swaps the image.
#   deploy/gcp/40-deploy.sh [--skip-migrate] [commit]      (default: HEAD; the image must exist: 30-build.sh)
# --skip-migrate is a smoke deploy that leaves the database alone: /health plus
# `gcloud run jobs execute mailme-tick --args=…,--check` prove image, settings, keys and Cloud SQL.
set -euo pipefail
source "$(dirname "$0")/config.sh"

skip_migrate=false
if [ "${1:-}" = "--skip-migrate" ]; then
  skip_migrate=true
  shift
fi
tag="${1:-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)}"
image="$(image_uri):$tag"
gcloud artifacts docker images describe "$image" --project "$PROJECT" --quiet >/dev/null 2>&1 || die "no image $image: run 30-build.sh first"
for s in "$SECRET_DB_URL" "$SECRET_MASTER_KEY" "$SECRET_APP_SECRET" "$SECRET_PUBLIC_KEY" "$SECRET_PRIVATE_KEY"; do
  exists_secret "$s" || die "secret $s missing: run 10-setup.sh and 20-secrets.sh first"
done
base_url="$(public_url)" # APP_BASE_URL
check_url="$(run_url)"  # health checks: reachable before (and regardless of) the domain mapping

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Non-secret settings as JSON (valid YAML for --env-vars-file). Behaviour settings are copied from the local .env so
# the cloud behaves like a local install; place-specific ones (database, URLs, key paths, data dir) are set here.
# AI_MODE comes from .env too (mock when unset); claude also needs the ANTHROPIC_API_KEY secret (20-secrets.sh).
env_file() {
  (cd "$REPO_ROOT" && node -e '
    const { readFileSync } = require("node:fs");
    const { parseEnv } = require("node:util");
    const [kind, base, pub, priv, tickJob] = process.argv.slice(1);
    const local = parseEnv(readFileSync(".env", "utf8"));
    const CARRY = ["LOG_LEVEL", "AI_MODEL", "AI_EFFORT", "AI_FALLBACKS", "AI_CACHE_TTL", "AI_MAX_TOKENS", "AI_TIMEOUT_MS",
      "AI_MAX_RETRIES", "AI_STRICT_ENUMS", "AI_DAILY_CALL_CAP", "AI_DAILY_USD_CAP", "SYNC_INTERVAL_SEC", "FOLDER_POLL_SEC",
      "SETTLE_SEC", "MAX_FETCH_BYTES", "BACKFILL_DAYS", "LATE_DISCOVERY_MAX_DAYS", "BODY_RETENTION_DAYS",
      "CLOSED_TASK_RETENTION_DAYS", "PLATFORM_MAIL_DOMAIN", "DEFAULT_TIMEZONE", "AUTH_REQUIRE_MFA", "CREDENTIALS_KID", "DENY_LIST"];
    const env = {};
    for (const k of CARRY) if (local[k] !== undefined && local[k] !== "") env[k] = local[k];
    Object.assign(env, { NODE_ENV: "production", AI_MODE: local.AI_MODE || "mock", APP_BASE_URL: base, CREDENTIALS_PUBLIC_KEY_FILE: pub });
    if (env.AUTH_REQUIRE_MFA === "false") throw new Error("AUTH_REQUIRE_MFA=false is for local development only");
    // TICK_JOB: the "Check now" button lets the API start the tick job (roles/run.invoker on that job, granted below).
    if (kind === "api") Object.assign(env, { HOST: "0.0.0.0", TRUST_PROXY: "1", TICK_JOB: tickJob });
    if (kind === "tick") Object.assign(env, { CREDENTIALS_PRIVATE_KEY_FILE: priv, DISK_CHECK: "off" });
    process.stdout.write(JSON.stringify(env, null, 2) + "\n");
  ' "$1" "$base_url" "$PUB_KEY_PATH" "$PRIV_KEY_PATH" "projects/$PROJECT/locations/$REGION/jobs/$TICK_JOB") >"$work/$1.json"
}
# At the top level, so a failure stops the script (inside $(…) it would not).
env_file migrate
env_file api
env_file tick

common_secrets="DATABASE_URL=$SECRET_DB_URL:latest,MASTER_KEY=$SECRET_MASTER_KEY:latest,APP_SECRET=$SECRET_APP_SECRET:latest"
exists_secret "$SECRET_LINK_SECRET" && common_secrets+=",LINK_SECRET=$SECRET_LINK_SECRET:latest"
pub_mount="$PUB_KEY_PATH=$SECRET_PUBLIC_KEY:latest"
priv_mount="$PRIV_KEY_PATH=$SECRET_PRIVATE_KEY:latest"
tick_secrets="$common_secrets,$pub_mount,$priv_mount"
if [ "$(dotenv_get AI_MODE)" = claude ]; then
  exists_secret "$SECRET_ANTHROPIC_KEY" || die "AI_MODE=claude but secret $SECRET_ANTHROPIC_KEY is missing: run 20-secrets.sh"
  tick_secrets+=",ANTHROPIC_API_KEY=$SECRET_ANTHROPIC_KEY:latest"
fi

if $skip_migrate; then
  note "Migrations skipped (smoke deploy): the database is left as it is"
else
  note "Migrations ($MIGRATE_JOB, $tag)"
  gcloud run jobs deploy "$MIGRATE_JOB" --project "$PROJECT" --region "$REGION" --image "$image" \
    --service-account "$(sa_email "$SA_WORKER")" --set-cloudsql-instances "$(sql_connection)" \
    --env-vars-file "$work/migrate.json" --set-secrets "$common_secrets" \
    --args=node_modules/.bin/tsx,src/cli/main.ts,db:migrate \
    --tasks 1 --max-retries 0 --task-timeout 10m --cpu 1 --memory 512Mi \
    --execute-now --wait --quiet
fi

note "API ($API_SERVICE): starts on demand, at most one instance"
# One instance keeps the in-memory login/TOTP rate limits in one process, and stays far below f1-micro's connection
# limit (pool of 10 per process). The private key is not mounted here.
gcloud run deploy "$API_SERVICE" --project "$PROJECT" --region "$REGION" --image "$image" \
  --service-account "$(sa_email "$SA_API")" --set-cloudsql-instances "$(sql_connection)" \
  --env-vars-file "$work/api.json" --set-secrets "$common_secrets,$pub_mount" \
  --port 3000 --cpu 1 --memory 512Mi --cpu-boost --cpu-throttling --execution-environment gen2 \
  --min-instances 0 --max-instances 1 --concurrency 40 --timeout 120 \
  --ingress all --allow-unauthenticated --quiet

note "Tick job ($TICK_JOB): one worker pass per execution"
gcloud run jobs deploy "$TICK_JOB" --project "$PROJECT" --region "$REGION" --image "$image" \
  --service-account "$(sa_email "$SA_WORKER")" --set-cloudsql-instances "$(sql_connection)" \
  --env-vars-file "$work/tick.json" --set-secrets "$tick_secrets" \
  --args=node_modules/.bin/tsx,src/worker/main.ts,--tick \
  --tasks 1 --max-retries 0 --task-timeout 30m --cpu 1 --memory 512Mi --quiet
# "Check now": the API may start this one job as deployed. roles/run.invoker holds run.jobs.run but not
# run.jobs.runWithOverrides, so the API cannot change the job's args, env or image. Never widen it.
gcloud run jobs add-iam-policy-binding "$TICK_JOB" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:$(sa_email "$SA_API")" --role roles/run.invoker --quiet >/dev/null
echo "  roles/run.invoker on $TICK_JOB → $SA_API (the \"Check now\" button)"

note "Checks"
if curl -fsS --max-time 60 "$check_url/health" | grep -q '"ok":true'; then
  echo "  $check_url/health: ok (API up, database reachable)"
else
  die "$check_url/health did not answer ok: gcloud run services logs read $API_SERVICE --project $PROJECT --region $REGION"
fi
if [ -n "$MAILME_DOMAIN" ]; then
  if domain_ready && curl -fsS --max-time 30 "$base_url/health" | grep -q '"ok":true'; then
    echo "  $base_url/health: ok (domain mapping ready)"
  else
    echo "  NOTE: $base_url is not serving yet ($(domain_status)): logins only work there, see 45-domain.sh" >&2
  fi
else
  urls="$(gcloud run services describe "$API_SERVICE" --project "$PROJECT" --region "$REGION" \
    --format='value(metadata.annotations."run.googleapis.com/urls",status.url)')"
  grep -q "$base_url" <<<"$urls" || echo "  WARNING: APP_BASE_URL $base_url is not among the service's URLs ($urls)" >&2
fi
if $skip_migrate; then
  note "Smoke check of the tick job: start-up only (--check: settings, both keys, Cloud SQL), no lock, no data"
  gcloud run jobs execute "$TICK_JOB" --project "$PROJECT" --region "$REGION" \
    --args=node_modules/.bin/tsx,src/worker/main.ts,--check --wait ||
    die "the tick job's check failed: gcloud logging read 'resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$TICK_JOB\"' --project $PROJECT --limit 30"
fi
note "Released $tag. Only $base_url works for logins (the service's other URLs fail the Origin check)."
