#!/usr/bin/env bash
# Start reading mail: one worker pass by hand, then Cloud Scheduler runs the tick job every 5 minutes.
# Run it once, after the first 40-deploy.sh. Idempotent: an existing schedule is updated and resumed.
#   deploy/gcp/50-schedule.sh            create or update the schedule
#   deploy/gcp/50-schedule.sh --pause    pause it (no worker passes until you run this script again)
set -euo pipefail
source "$(dirname "$0")/config.sh"

exists_job "$TICK_JOB" || die "the tick job $TICK_JOB does not exist yet: run 40-deploy.sh first"
exists_sa "$SA_SCHEDULER" || die "service account $SA_SCHEDULER missing: run 10-setup.sh first"

if [ "${1:-}" = "--pause" ]; then
  exists_scheduler || die "no schedule to pause"
  gcloud scheduler jobs pause "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" >/dev/null
  note "Paused. Mail is not read until you run deploy/gcp/50-schedule.sh again."
  exit 0
fi

note "One tick by hand (a full worker pass: sync, AI, reports, health)"
gcloud run jobs execute "$TICK_JOB" --project "$PROJECT" --region "$REGION" --wait ||
  die "the tick failed: gcloud logging read 'resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$TICK_JOB\"' --project $PROJECT --limit 50"

note "Cloud Scheduler: $TICK_JOB at \"$TICK_SCHEDULE\" ($TIME_ZONE)"
gcloud run jobs add-iam-policy-binding "$TICK_JOB" --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:$(sa_email "$SA_SCHEDULER")" --role roles/run.invoker --quiet >/dev/null
run_uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$TICK_JOB:run"
if exists_scheduler; then
  gcloud scheduler jobs update http "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" \
    --schedule "$TICK_SCHEDULE" --time-zone "$TIME_ZONE" --uri "$run_uri" --http-method POST \
    --oauth-service-account-email "$(sa_email "$SA_SCHEDULER")" --attempt-deadline 180s >/dev/null
  gcloud scheduler jobs resume "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" >/dev/null
else
  gcloud scheduler jobs create http "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" \
    --schedule "$TICK_SCHEDULE" --time-zone "$TIME_ZONE" --uri "$run_uri" --http-method POST \
    --oauth-service-account-email "$(sa_email "$SA_SCHEDULER")" --attempt-deadline 180s >/dev/null
fi
note "Done: a worker pass runs every 5 minutes. Pause it with: deploy/gcp/50-schedule.sh --pause"
