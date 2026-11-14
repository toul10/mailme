# Shared settings and helpers for the deploy/gcp scripts (sourced, not run). Nothing in this file is secret.
# Every gcloud call passes --project/--region explicitly: the global gcloud configuration is never changed.

# Your Google Cloud project and region: export MAILME_GCP_PROJECT=my-project (and MAILME_GCP_REGION) first.
PROJECT="${MAILME_GCP_PROJECT:?export MAILME_GCP_PROJECT=<your Google Cloud project id> first (deploy/gcp/README.md)}"
REGION="${MAILME_GCP_REGION:-europe-west1}"
# Your public address, e.g. mailme.example.com: a Cloud Run domain mapping (45-domain.sh; DNS: a CNAME to
# ghs.googlehosted.com). Empty (the default): the service's run.app address is the public one.
MAILME_DOMAIN="${MAILME_DOMAIN-}"

SQL_INSTANCE=mailme-pg
SQL_TIER=db-f1-micro          # shared core, 0.6 GB: the cheapest Cloud SQL (Enterprise edition only)
DB_NAME=mailme
DB_USER=mailme

AR_REPO=mailme
IMAGE_NAME=mailme
API_SERVICE=mailme-api        # Cloud Run service, starts on demand (min 0)
TICK_JOB=mailme-tick          # Cloud Run job: one worker pass (src/worker/tick.ts)
MIGRATE_JOB=mailme-migrate    # Cloud Run job: db:migrate
SCHEDULER_JOB=mailme-tick     # Cloud Scheduler → runs TICK_JOB
TICK_SCHEDULE="${MAILME_TICK_SCHEDULE:-*/5 * * * *}"
TIME_ZONE="${MAILME_TIME_ZONE:-Etc/UTC}" # of the schedule only; every 5 minutes is the same in any zone

SA_API=mailme-api             # the API: public key only
SA_WORKER=mailme-worker       # the jobs: also the private key that opens mailbox passwords
SA_SCHEDULER=mailme-scheduler # may only start TICK_JOB

SECRET_DB_URL=mailme-database-url
SECRET_MASTER_KEY=mailme-master-key
SECRET_APP_SECRET=mailme-app-secret
SECRET_LINK_SECRET=mailme-link-secret
SECRET_PUBLIC_KEY=mailme-credentials-public-key
SECRET_PRIVATE_KEY=mailme-credentials-private-key
SECRET_ANTHROPIC_KEY=mailme-anthropic-api-key   # only when .env has ANTHROPIC_API_KEY; the jobs' account only
# Cloud Run mounts each secret in its own directory.
PUB_KEY_PATH=/secrets/pub/credentials.pub.pem
PRIV_KEY_PATH=/secrets/priv/credentials.key.pem

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }
note() { echo "── $*"; }
confirm() {
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

sa_email() { echo "$1@$PROJECT.iam.gserviceaccount.com"; }
project_number() { gcloud projects describe "$PROJECT" --format='value(projectNumber)'; }
# The deterministic Cloud Run URL: always reachable, so every health check uses it.
run_url() { echo "https://$API_SERVICE-$(project_number).$REGION.run.app"; }
# APP_BASE_URL: the one address where logins work (cookies and the Origin check derive from it; every other URL of
# the service serves the same app, but its logins fail), and the address in the reports' links.
public_url() { if [ -n "$MAILME_DOMAIN" ]; then echo "https://$MAILME_DOMAIN"; else run_url; fi; }
# Ready / CertificateProvisioned / DomainRoutable of the domain mapping as "Type=Status …" (empty: no mapping).
domain_status() {
  gcloud beta run domain-mappings describe --domain "$MAILME_DOMAIN" --project "$PROJECT" --region "$REGION" --format=json --quiet 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!s.trim())return;const c=JSON.parse(s).status?.conditions??[];process.stdout.write(c.map(x=>`${x.type}=${x.status}`).join(" "))})'
}
domain_ready() { [ -n "$MAILME_DOMAIN" ] && grep -q "Ready=True" <<<"$(domain_status)"; }
image_uri() { echo "$REGION-docker.pkg.dev/$PROJECT/$AR_REPO/$IMAGE_NAME"; }
sql_connection() { echo "$PROJECT:$REGION:$SQL_INSTANCE"; }

# A value from the local .env file itself, with Node's own .env parser (the app's): byte-identical secrets. Unlike
# process.loadEnvFile, a variable exported in this shell does not win: a stray DATABASE_URL would dump another database.
dotenv_get() {
  (cd "$REPO_ROOT" && node -e 'const { parseEnv } = require("node:util"); const v = parseEnv(require("node:fs").readFileSync(".env", "utf8"))[process.argv[1]]; process.stdout.write(v ?? "")' "$1")
}
# A path from the local .env, resolved against the repo root (the app resolves it against its working directory).
dotenv_path() {
  local p
  p="$(dotenv_get "$1")"
  [ -n "$p" ] || return 0
  case "$p" in /*) echo "$p" ;; *) echo "$REPO_ROOT/${p#./}" ;; esac
}

exists_secret() { gcloud secrets describe "$1" --project "$PROJECT" --quiet >/dev/null 2>&1; }
exists_sa() { gcloud iam service-accounts describe "$(sa_email "$1")" --project "$PROJECT" --quiet >/dev/null 2>&1; }
exists_sql() { gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT" --quiet >/dev/null 2>&1; }
exists_job() { gcloud run jobs describe "$1" --project "$PROJECT" --region "$REGION" --quiet >/dev/null 2>&1; }
exists_service() { gcloud run services describe "$1" --project "$PROJECT" --region "$REGION" --quiet >/dev/null 2>&1; }
exists_scheduler() { gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" --quiet >/dev/null 2>&1; }

