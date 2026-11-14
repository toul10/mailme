#!/usr/bin/env bash
# Build the image of the current commit with Cloud Build (in $REGION) and push it to Artifact Registry, tagged with the
# commit. Refuses uncommitted changes: the tag must say exactly what is inside. .gcloudignore keeps .env, keys and
# data/ out of the upload.
set -euo pipefail
source "$(dirname "$0")/config.sh"

[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] || die "uncommitted changes in $REPO_ROOT: commit first (the image is tagged with the commit)"
tag="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
image="$(image_uri):$tag"
if gcloud artifacts docker images describe "$image" --project "$PROJECT" --quiet >/dev/null 2>&1; then
  note "$image is already built"
  exit 0
fi
note "Building $image"
gcloud builds submit "$REPO_ROOT" --project "$PROJECT" --region "$REGION" --tag "$image"
note "Done. Next: 40-deploy.sh $tag (and 50-schedule.sh after the first deploy)"
