#!/usr/bin/env bash
# The public address: a Cloud Run domain mapping $MAILME_DOMAIN → mailme-api, with a Google-managed certificate.
# Needs, once, from whoever owns the gcloud account (README § Your own address):
#   1. the apex domain verified in Google Search Console as THAT account (Domain property, TXT record at the apex);
#   2. DNS: CNAME <name> → ghs.googlehosted.com at your DNS provider, not proxied (Cloudflare: "DNS only").
#   deploy/gcp/45-domain.sh [--wait]   creates the mapping if missing, prints the DNS record and the status;
#                                      --wait polls until it is ready and https://$MAILME_DOMAIN/health answers (≤ 60 min)
set -euo pipefail
source "$(dirname "$0")/config.sh"

[ -n "$MAILME_DOMAIN" ] || die "MAILME_DOMAIN is empty: the run.app address is the public one, nothing to map"
wait=false
[ "${1:-}" = "--wait" ] && wait=true
apex="${MAILME_DOMAIN#*.}"
exists_service "$API_SERVICE" || die "$API_SERVICE does not exist yet: run 40-deploy.sh --skip-migrate first"
gcloud domains list-user-verified --format='value(id)' 2>/dev/null | grep -qx "$apex" ||
  die "$apex is not verified for $(gcloud config get-value account 2>/dev/null): Search Console → Domain property \"$apex\" (TXT record at the apex), signed in as that account"

if [ -z "$(domain_status)" ]; then
  note "Creating the domain mapping $MAILME_DOMAIN → $API_SERVICE"
  gcloud beta run domain-mappings create --service "$API_SERVICE" --domain "$MAILME_DOMAIN" \
    --project "$PROJECT" --region "$REGION" --quiet >/dev/null
fi

note "DNS record it expects (not proxied; Cloudflare: \"DNS only\")"
gcloud beta run domain-mappings describe --domain "$MAILME_DOMAIN" --project "$PROJECT" --region "$REGION" --format=json |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s).status?.resourceRecords??[])console.log(`  ${r.type}  ${r.name||"@"}  →  ${r.rrdata}`)})'
echo "  $MAILME_DOMAIN resolves to: $(dig +short "$MAILME_DOMAIN" | tr '\n' ' ')"

serving() { curl -fsS --max-time 15 "https://$MAILME_DOMAIN/health" 2>/dev/null | grep -q '"ok":true'; }
if $wait; then
  note "Waiting for the certificate (usually 15–60 minutes after the CNAME resolves)"
  for _ in $(seq 1 120); do
    domain_ready && serving && break
    sleep 30
  done
fi
note "Status: $(domain_status)"
if domain_ready && serving; then
  echo "  https://$MAILME_DOMAIN/health: ok"
else
  echo "  not serving yet. If your DNS provider proxies the record (e.g. Cloudflare's orange cloud), switch it to DNS only." >&2
  $wait && exit 1
fi
