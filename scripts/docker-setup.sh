#!/usr/bin/env bash
# MailMe with Docker Compose — first-run setup. Safe to run again: it only adds what is missing.
#
#   ./scripts/docker-setup.sh            asks for your domain, e-mail and name
#   ./scripts/docker-setup.sh --help     options (for scripts and CI)
#
# What it does:
#   1. writes .env: generated secrets and database password, your domain (every value already in .env is kept);
#   2. builds the image and creates the key pair that seals mailbox passwords (./data/keys);
#   3. starts postgres → migrate → api + worker → caddy (HTTPS);
#   4. creates your organization and your account, and prints a one-time setup link.
# Needs Docker with Compose v2, nothing else. docs/INSTALL.md is the full guide.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
MailMe Docker setup — ./scripts/docker-setup.sh [options]

  --yes                 Don't ask; use the options and defaults (scripts, CI)
  --domain <name>       Domain people open, e.g. mailme.example.com (default: localhost, a test on this machine)
  --email <e-mail>      Your e-mail: your login, and Let's Encrypt's contact for the certificate (needed with --yes)
  --name <name>         Your name (default: from the e-mail address)
  --org <name>          Your company or team (default "My company")
  --domains <a,b>       Your company's mail domains: mail from them counts as a colleague
                        (default: the domain of --email, unless it is a free-mail domain)
  --timezone <zone>     IANA timezone, e.g. Europe/London (default: this machine's)
  --ai-mode <mode>      mock (default: free, rough results) or claude (needs an Anthropic API key)
  --help

The Anthropic API key is never an option (it would land in your shell history): the setup asks for it, or
you add ANTHROPIC_API_KEY to .env and run: docker compose up -d
EOF
}

die() { printf '\n%s\n' "$*" >&2; exit 1; }
ok() { printf '  ✓ %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
need_value() { [ "$2" -ge 2 ] || die "$1 needs a value (see --help)"; }

YES=0 DOMAIN="" EMAIL="" NAME="" ORG="" DOMAINS="" ZONE="" AI=""
while [ $# -gt 0 ]; do
  case "$1" in
    -y | --yes) YES=1 ;;
    --domain) need_value "$1" $#; DOMAIN="$2"; shift ;;
    --email) need_value "$1" $#; EMAIL="$2"; shift ;;
    --name) need_value "$1" $#; NAME="$2"; shift ;;
    --org) need_value "$1" $#; ORG="$2"; shift ;;
    --domains) need_value "$1" $#; DOMAINS="$2"; shift ;;
    --timezone) need_value "$1" $#; ZONE="$2"; shift ;;
    --ai-mode) need_value "$1" $#; AI="$2"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ask VAR "Question" "default" — with --yes the default is the answer.
ask() {
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if [ "$YES" = 1 ]; then
    printf -v "$__var" '%s' "$__def"
    return
  fi
  if [ -n "$__def" ]; then read -r -p "  $__q [$__def]: " __ans || true; else read -r -p "  $__q: " __ans || true; fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ── .env helpers: line by line, so comments survive; a value already there is never replaced ───────────────────
# A KEY line as Node's .env parser reads it: optional "export ", spaces around "=".
key_re() { printf '^[[:space:]]*(export[[:space:]]+)?%s[[:space:]]*=' "$1"; }
env_get() {
  local line
  line="$(grep -E "$(key_re "$1")" .env | head -n 1 || true)"
  line="${line#*=}"
  line="${line%%#*}"
  line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/')"
  printf '%s' "$line"
}
env_put() { # replace the first KEY= line (or "# KEY=" line), or append
  local key="$1" value="$2"
  # A line break would start another setting; quotes and backslashes would change the value.
  case "$value" in *$'\n'* | *$'\r'* | *'"'* | *'\'*) die "Refusing a value for $key with a quote, a backslash or a line break." ;; esac
  # Values reach awk through the environment, never its arguments: other users can read a process's arguments.
  if grep -qE "$(key_re "$key")" .env; then
    K="$key" V="$value" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; re = "^[[:space:]]*(export[[:space:]]+)?" k "[[:space:]]*=" }
      !done && $0 ~ re { print k "=" v; done = 1; next } { print }' .env >.env.tmp
  elif grep -qE "^#[[:space:]]*$key=" .env; then
    K="$key" V="$value" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; re = "^#[[:space:]]*" k "=" }
      !done && $0 ~ re { print k "=" v; done = 1; next } { print }' .env >.env.tmp
  else
    cp .env .env.tmp
    printf '%s=%s\n' "$key" "$value" >>.env.tmp
  fi
  mv -f .env.tmp .env # atomic; owner-only, like every file this script creates (umask 077)
}
ADDED=()
env_default() { # set KEY only if it has no value (a fresh .env takes the answer over the template's suggestion)
  if [ "$FRESH" = 1 ] || [ -z "$(env_get "$1")" ]; then
    env_put "$1" "$2"
    ADDED+=("$1")
  fi
}
rand_b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
rand_b64url() { rand_b64 "$1" | tr '+/' '-_' | tr -d '='; }
rand_hex() { od -An -tx1 -N "$1" /dev/urandom | tr -d ' \n'; }

ZONE_RE='^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$' # an IANA name such as Europe/London or America/Argentina/Salta
host_timezone() {
  local tz=""
  if [ -n "${TZ:-}" ]; then tz="$TZ"; fi
  [[ "$tz" =~ $ZONE_RE ]] || tz="" # e.g. TZ=:/etc/localtime
  if [ -z "$tz" ] && command -v timedatectl >/dev/null 2>&1; then tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"; fi
  if [ -z "$tz" ] && [ -L /etc/localtime ]; then tz="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"; fi
  [[ "$tz" =~ $ZONE_RE ]] || tz=""
  printf '%s' "${tz:-UTC}"
}

# ── 0. Checks ─────────────────────────────────────────────────────────────────────────────────────────────────
printf 'MailMe Docker setup\n'
command -v docker >/dev/null 2>&1 || die "Docker is not installed: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command): https://docs.docker.com/compose/install/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running: start Docker Desktop (or the docker service) and run this again."
[ -f docker-compose.yml ] && [ -f .env.example ] || die "Run this from the MailMe folder: ./scripts/docker-setup.sh"

# ── 1. Configuration ──────────────────────────────────────────────────────────────────────────────────────────
step "1. Configuration (.env)"
FRESH=0
if [ ! -f .env ]; then
  cp .env.example .env
  FRESH=1
  # A new .env that this step doesn't finish is removed again, so the next run starts over and asks everything.
  trap 'rm -f .env .env.tmp' EXIT
fi
chmod 600 .env

CUR_DOMAIN="$(env_get MAILME_DOMAIN)"
if [ "$FRESH" = 1 ] || [ -z "$CUR_DOMAIN" ]; then
  if [ "$YES" != 1 ]; then
    printf '  The domain people open, e.g. mailme.example.com. Its DNS must point to this machine, ports 80 and 443 open.\n'
    printf '  "localhost" tries MailMe on this machine only (the browser warns about the certificate).\n'
  fi
  ask DOMAIN "Domain" "${DOMAIN:-localhost}"
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "Not a domain name: $DOMAIN"
  env_put MAILME_DOMAIN "$DOMAIN"
  ADDED+=(MAILME_DOMAIN)
else
  [ -z "$DOMAIN" ] || [ "$DOMAIN" = "$CUR_DOMAIN" ] || printf '  ! MAILME_DOMAIN is already in .env (%s); keeping it (edit .env to change it).\n' "$CUR_DOMAIN"
  DOMAIN="$CUR_DOMAIN"
  ok "domain: $DOMAIN (from .env)"
fi

CUR_ACME="$(env_get ACME_EMAIL)"
if [ -z "$EMAIL" ] && [ -n "$CUR_ACME" ] && [ "$FRESH" = 0 ]; then EMAIL="$CUR_ACME"; fi
if [ -z "$EMAIL" ]; then
  [ "$YES" = 1 ] && die "--email is needed with --yes"
  ask EMAIL "Your e-mail address (your login)" ""
fi
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "That doesn't look like an e-mail address: $EMAIL"
EMAIL="$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')"
[ "$FRESH" = 1 ] || [ -z "$CUR_ACME" ] && { env_put ACME_EMAIL "$EMAIL"; ADDED+=(ACME_EMAIL); }

[ -n "$(env_get POSTGRES_PASSWORD)" ] || { env_put POSTGRES_PASSWORD "$(rand_hex 24)"; ADDED+=(POSTGRES_PASSWORD); }
[ -n "$(env_get MASTER_KEY)" ] || { env_put MASTER_KEY "$(rand_b64 32)"; ADDED+=(MASTER_KEY); }
[ -n "$(env_get APP_SECRET)" ] || { env_put APP_SECRET "$(rand_b64url 48)"; ADDED+=(APP_SECRET); }
[ -n "$(env_get LINK_SECRET)" ] || { env_put LINK_SECRET "$(rand_b64url 48)"; ADDED+=(LINK_SECRET); }

if [ "$FRESH" = 1 ] || [ -z "$(env_get DEFAULT_TIMEZONE)" ]; then
  ask ZONE "Timezone" "${ZONE:-$(host_timezone)}"
  [[ "$ZONE" =~ $ZONE_RE ]] || die "Not a timezone name: $ZONE (e.g. Europe/London; --timezone sets it)"
  env_default DEFAULT_TIMEZONE "$ZONE"
else
  ZONE="${ZONE:-$(env_get DEFAULT_TIMEZONE)}"
fi

if [ "$FRESH" = 1 ] || [ -z "$(env_get AI_MODE)" ]; then
  if [ "$YES" != 1 ]; then
    printf '  AI: mock is free and needs no key, but its results are rough (fine for trying MailMe out).\n'
    printf '      claude reads your mail with the Claude API: needs an Anthropic API key and costs money per message.\n'
  fi
  ask AI "AI (mock or claude)" "${AI:-mock}"
  [ "$AI" = mock ] || [ "$AI" = claude ] || die "--ai-mode must be mock or claude"
  env_default AI_MODE "$AI"
fi
if [ "$(env_get AI_MODE)" = claude ] && [ -z "$(env_get ANTHROPIC_API_KEY)" ] && [ "$YES" != 1 ]; then
  KEY_IN=""
  read -r -s -p "  Anthropic API key (Enter to add it to .env later): " KEY_IN || true
  printf '\n'
  if [ -n "$KEY_IN" ]; then env_put ANTHROPIC_API_KEY "$KEY_IN"; ADDED+=(ANTHROPIC_API_KEY); fi
  unset KEY_IN
fi

if [ "$FRESH" = 1 ]; then ok ".env created (owner-only permissions), with new secrets"
elif [ ${#ADDED[@]} -gt 0 ]; then ok ".env: added ${ADDED[*]}; every value already there was kept"
else ok ".env is complete; nothing changed"; fi
trap - EXIT # step 1 is complete: .env stays, whatever happens next

# ── 2. Image and keys ─────────────────────────────────────────────────────────────────────────────────────────
step "2. Image and keys"
printf '  building the image… (a few minutes the first time)\n'
docker compose build || die "The image build failed (see above)."
ok "image built"

PUB=data/keys/credentials.pub.pem
KEY=data/keys/credentials.key.pem
mkdir -p data/keys
if [ -f "$PUB" ] && [ -f "$KEY" ]; then
  ok "kept the existing key pair ($PUB, $KEY)"
elif [ -f "$PUB" ] || [ -f "$KEY" ]; then
  die "Only one of the two key files exists in data/keys. Mailbox passwords sealed with the old pair can't be opened without both. Restore the missing file, or — if no mailbox is connected yet — delete the other one and run this again."
else
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/data/keys:/keys" mailme:latest \
    node_modules/.bin/tsx src/cli/main.ts keys:generate --out-dir /keys >/dev/null || die "Creating the key pair failed."
  [ -f "$PUB" ] && [ -f "$KEY" ] || die "The key pair wasn't written to data/keys (is this folder shared with Docker?)."
  ok "created $PUB and $KEY (private: never commit it or back it up with the database)"
fi
# Inside the containers the api and worker run as uid 1000 (node) and read these files as compose secrets.
if [ "$(uname -s)" = Linux ] && [ "$(id -u)" != 1000 ]; then
  if [ "$(id -u)" = 0 ]; then chown 1000:1000 "$PUB" "$KEY"; else
    printf '  The containers run as uid 1000 and must read the keys; this needs sudo:\n'
    sudo chown 1000:1000 "$PUB" "$KEY" || die "Run: sudo chown 1000:1000 $PUB $KEY"
  fi
  ok "keys readable by the containers (uid 1000)"
fi

# ── 3. Start ──────────────────────────────────────────────────────────────────────────────────────────────────
step "3. Starting MailMe"
docker compose up -d || die "docker compose up failed (see above; docker compose logs shows more)."
printf '  waiting for the API…'
for _ in $(seq 1 90); do
  if docker compose exec -T api wget -q -O /dev/null http://127.0.0.1:3000/health 2>/dev/null; then
    READY=1
    break
  fi
  printf '.'
  sleep 2
done
printf '\n'
[ "${READY:-0}" = 1 ] || die "The API didn't come up. See: docker compose logs migrate api"
ok "postgres, api, worker and caddy are running (docker compose ps)"

# ── 4. Account ────────────────────────────────────────────────────────────────────────────────────────────────
step "4. Your account"
if [ -z "$NAME" ] && [ "$YES" != 1 ]; then ask NAME "Your name" ""; fi
if [ -z "$ORG" ] && [ "$YES" != 1 ]; then ask ORG "Your company or team" "My company"; fi
ARGS=(--account-only --yes --admin-email "$EMAIL" --timezone "$ZONE")
[ -n "$NAME" ] && ARGS+=(--admin-name "$NAME")
[ -n "$ORG" ] && ARGS+=(--org "$ORG")
[ -n "$DOMAINS" ] && ARGS+=(--domains "$DOMAINS")
OUT="$(docker compose exec -T api node_modules/.bin/tsx scripts/setup.ts "${ARGS[@]}")" || { printf '%s\n' "$OUT"; die "Creating your account failed (see above)."; }
printf '%s\n' "$OUT" | sed -n '/^4\./,$p' | sed '1d'

step "Done."
if [ "$DOMAIN" = localhost ]; then
  printf '  MailMe runs at https://localhost (a test certificate: let the browser continue past the warning).\n'
else
  printf '  MailMe runs at https://%s (the certificate arrives within a minute once DNS points here).\n' "$DOMAIN"
fi
printf '  Next: open the setup link above, choose your password, set up two-step sign-in, then connect your\n'
printf '  mailbox in Settings → Mailboxes. Guide: docs/INSTALL.md\n'
printf '  Logs: docker compose logs -f api worker · Stop: docker compose down · Update: git pull && ./scripts/docker-setup.sh\n'
