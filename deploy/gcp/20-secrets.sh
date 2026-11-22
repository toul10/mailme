#!/usr/bin/env bash
# Copy the local secrets (.env and the key files) to Secret Manager BYTE-IDENTICAL, and grant each one only to the
# service accounts that need it. Create them locally first: install -m 600 .env.example .env, paste the output of
# `pnpm cli secrets:generate` into it, then `pnpm cli keys:generate` (README § First deploy).
#   MASTER_KEY  encrypts the TOTP seeds: a different value locks every user out of MFA
#   APP_SECRET  session cookies;  LINK_SECRET  signed one-click links in the reports already sent
#   the credentials key pair: the private key opens every stored mailbox password → the worker's account ONLY
#   ANTHROPIC_API_KEY (if set in .env): only the jobs read mail with the AI → the worker's account ONLY
#   CHAT_API_KEY (if set in .env): the chat ("Ask your mail") runs in the API → the API's account ONLY
# Values are never printed. An existing secret with a DIFFERENT value is not overwritten unless --replace is given.
set -euo pipefail
source "$(dirname "$0")/config.sh"

replace=false
[ "${1:-}" = "--replace" ] && replace=true

[ -f "$REPO_ROOT/.env" ] || die "$REPO_ROOT/.env is missing"
pub="$(dotenv_path CREDENTIALS_PUBLIC_KEY_FILE)"
pub="${pub:-$REPO_ROOT/data/keys/credentials.pub.pem}"
priv="$(dotenv_path CREDENTIALS_PRIVATE_KEY_FILE)"
[ -f "$pub" ] || die "public key not found: $pub"
[ -n "$priv" ] && [ -f "$priv" ] || die "private key not found: set CREDENTIALS_PRIVATE_KEY_FILE in .env"
exists_sa "$SA_API" && exists_sa "$SA_WORKER" || die "service accounts missing: run 10-setup.sh first"

work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

# put_secret NAME < value
put_secret() {
  local name="$1" file="$work/value" current="$work/current"
  cat >"$file"
  [ -s "$file" ] || die "$name: the local value is empty"
  if exists_secret "$name"; then
    gcloud secrets versions access latest --secret "$name" --project "$PROJECT" --out-file "$current" >/dev/null
    if cmp -s "$file" "$current"; then
      echo "  $name: unchanged"
    elif $replace; then
      gcloud secrets versions add "$name" --data-file "$file" --project "$PROJECT" >/dev/null
      echo "  $name: NEW VERSION (redeploy with 40-deploy.sh to use it)"
    else
      die "$name exists with a different value; not overwritten (run with --replace only if that is intended)"
    fi
  else
    gcloud secrets create "$name" --data-file "$file" --replication-policy user-managed --locations "$REGION" \
      --project "$PROJECT" >/dev/null
    echo "  $name: created"
  fi
  rm -f "$file" "$current"
}

note "Secrets (from .env and the key files)"
dotenv_get MASTER_KEY | put_secret "$SECRET_MASTER_KEY"
dotenv_get APP_SECRET | put_secret "$SECRET_APP_SECRET"
if [ -n "$(dotenv_get LINK_SECRET)" ]; then
  dotenv_get LINK_SECRET | put_secret "$SECRET_LINK_SECRET"
else
  echo "  LINK_SECRET is not set locally: the app derives it from APP_SECRET, in the cloud too"
fi
put_secret "$SECRET_PUBLIC_KEY" <"$pub"
put_secret "$SECRET_PRIVATE_KEY" <"$priv"
if [ -n "$(dotenv_get ANTHROPIC_API_KEY)" ]; then
  dotenv_get ANTHROPIC_API_KEY | put_secret "$SECRET_ANTHROPIC_KEY"
elif [ "$(dotenv_get AI_MODE)" = claude ]; then
  die "AI_MODE=claude in .env but ANTHROPIC_API_KEY is not set there"
fi
if [ -n "$(dotenv_get CHAT_API_KEY)" ]; then
  dotenv_get CHAT_API_KEY | put_secret "$SECRET_CHAT_KEY"
elif [ "$(dotenv_get CHAT_MODE)" = gemini ]; then
  die "CHAT_MODE=gemini in .env but CHAT_API_KEY is not set there"
fi

note "Access (roles/secretmanager.secretAccessor, per secret)"
grant() {
  gcloud secrets add-iam-policy-binding "$1" --member "serviceAccount:$(sa_email "$2")" \
    --role roles/secretmanager.secretAccessor --condition None --project "$PROJECT" >/dev/null
  echo "  $1 → $2"
}
for s in "$SECRET_DB_URL" "$SECRET_MASTER_KEY" "$SECRET_APP_SECRET" "$SECRET_LINK_SECRET" "$SECRET_PUBLIC_KEY"; do
  exists_secret "$s" || continue
  grant "$s" "$SA_API"
  grant "$s" "$SA_WORKER"
done
grant "$SECRET_PRIVATE_KEY" "$SA_WORKER" # never the API: it seals with the public key and can never open a password
exists_secret "$SECRET_ANTHROPIC_KEY" && grant "$SECRET_ANTHROPIC_KEY" "$SA_WORKER"
# The chat's key: the API's account only. The worker never answers questions, and its own keys are not the API's.
exists_secret "$SECRET_CHAT_KEY" && grant "$SECRET_CHAT_KEY" "$SA_API"

note "Done. CREDENTIALS_KID is \"$(dotenv_get CREDENTIALS_KID)\" (40-deploy.sh copies it). Next: 30-build.sh"
