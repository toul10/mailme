# MailMe on Google Cloud (Cloud Run, on demand)

This is an alternative to [Docker on a server](../../docs/INSTALL.md#install-with-docker). The API is a Cloud Run
service that starts when someone opens it. The worker is a Cloud Run job that Cloud Scheduler starts every 5 minutes.
Between those moments nothing runs, and almost nothing is billed.

These scripts are for people who already use Google Cloud and the `gcloud` CLI. They create billable resources: read
each script before you run it.

```
 browser ──HTTPS──▶ your address ─▶ mailme-api (Cloud Run service, min 0 / max 1)   public key only
                        │
                        ├──── Cloud SQL mailme-pg (PostgreSQL 16, db-f1-micro, 10 GB HDD, backups + PITR)
                        │
 Cloud Scheduler ─▶ mailme-tick (Cloud Run job, every 5 min)            + the private key
   */5 * * * *          one worker pass: IMAP sync → drain → reports → aging → retention → health
                        │
                        └──── your mail server (IMAP/SMTP)
```

- **The worker runs as ticks.** `pnpm start:tick` (`src/worker/main.ts --tick`) does once what the always-on worker
  does on its timers, then exits.
  - A tick takes the same `"worker"` advisory lock, so it never overlaps another tick. A tick that finds the lock
    held exits 0 at once.
  - New mail becomes a task 5–10 minutes after it arrives: it waits for the settle window (`SETTLE_SEC` = 180 s)
    and for the next complete cycle. An always-on worker with IMAP IDLE takes 3–4 minutes.
  - The 07:30 report goes out with the first tick after 07:30, at most 5 minutes late.
- **Key isolation, as in Docker.** Only `mailme-worker`, the jobs' service account, can read the private key that
  opens mailbox passwords. The API seals with the public key and can never open one.
- **No static IP.** Cloud Run connects from Google's address pool, so your mail server sees changing Google
  addresses.
  - A tick every 5 minutes means about 288 sign-ins a day, the same as a mail client polling every 5 minutes.
  - If your provider objects, or must allowlist an address, see [Static egress IP](#static-egress-ip-optional).
- **Request logs are not stored.** One-click report links carry a signed token in the URL path.
  - `10-setup.sh` therefore excludes the API's request log from Cloud Logging.
  - The app's own logs name routes, never URLs.

## Costs

Rough monthly figures in USD for europe-west1, before any free tier. Check current prices in the Google Cloud
pricing calculator.

| Item | Per month |
|---|---|
| Cloud SQL db-f1-micro + 10 GB HDD + backups | ≈ $9 |
| Tick job every 5 minutes: 8,760 runs × the **1-minute minimum** billed per run × (1 vCPU, 512 MiB) | ≈ $10 |
| API, request-based, starts on demand | < $0.5 |
| Secret Manager, Scheduler, Artifact Registry, Logging | < $1 |
| **Total** | **≈ $20** |

- **The tick's cost is the billing minimum.** A tick typically takes a few seconds, but each run is billed for at
  least a minute.
  - Ticks every 10 minutes (`MAILME_TICK_SCHEDULE='*/10 * * * *'`) bring the total to about $15.
- **An always-on worker would cost more.** A Cloud Run service with CPU always on needs a whole vCPU around the
  clock: several times the tick job's cost.

## Scripts

Set your project first, then run the scripts from the repo root. Every command passes `--project` and `--region`,
so your global gcloud configuration is never changed.

```sh
export MAILME_GCP_PROJECT=my-project            # required
export MAILME_GCP_REGION=europe-west1           # optional (the default)
export MAILME_DOMAIN=mailme.example.com         # optional: your own address; empty = the run.app address
```

| Script | Does | Creates billable resources |
|---|---|---|
| `00-check.sh` | Read-only: what exists in the project and locally | no |
| `10-setup.sh` | APIs, Artifact Registry, service accounts, Cloud SQL, the database URL secret, IAM, the log exclusion | **yes** (Cloud SQL) |
| `20-secrets.sh` | Copies `MASTER_KEY`, `APP_SECRET`, `LINK_SECRET`, the key pair and (if `.env` has it) `ANTHROPIC_API_KEY` from your local `.env` and `data/keys`, byte-identical. Grants each one only where it is needed | secrets (cents) |
| `30-build.sh` | Builds the image of the current commit with Cloud Build. Refuses uncommitted changes | build minutes |
| `40-deploy.sh [--skip-migrate] [commit]` | Migrations (a job), then the API, then the tick job. Never starts ticks | the API and the jobs |
| `45-domain.sh [--wait]` | The domain mapping for `MAILME_DOMAIN`; `--wait` waits until its certificate serves | no |
| `50-schedule.sh [--pause]` | One tick by hand, then the schedule (every 5 minutes); `--pause` stops it | the ticks |

`MASTER_KEY` encrypts the TOTP seeds and must never change after people have signed in: a different value means
everyone sets up two-step sign-in again. `20-secrets.sh` therefore never overwrites a secret whose value differs,
unless you pass `--replace`.

## First deploy

1. **Local settings, no local database needed.**

   ```sh
   pnpm install
   install -m 600 .env.example .env  # owner-only from the start
   pnpm cli secrets:generate      # paste the three lines into .env
   pnpm cli keys:generate         # data/keys/credentials.{pub,key}.pem
   ```

   Keep `AI_MODE=auto`, as in `.env.example` (unset means the same). After the deploy you choose the AI
   provider and paste its key in **Admin → AI** (see *Choosing the AI* in § Operations). `AI_MODE=mock` keeps AI
   off whatever is chosen there.
   `40-deploy.sh` copies the behaviour settings from `.env`: the AI options, the sync intervals, retention,
   `DEFAULT_TIMEZONE` and `DENY_LIST`.

2. **Infrastructure and release.**

   ```sh
   deploy/gcp/00-check.sh                    # read-only overview
   deploy/gcp/10-setup.sh                    # about 10 minutes (Cloud SQL)
   deploy/gcp/20-secrets.sh
   deploy/gcp/30-build.sh                    # commit first: the image is tagged with the commit
   deploy/gcp/40-deploy.sh
   deploy/gcp/45-domain.sh --wait            # only with MAILME_DOMAIN (see § Your own address)
   ```

3. **Your account.** It goes through the Cloud SQL Auth Proxy, from your machine; see § Operations for the proxy:

   ```sh
   DATABASE_URL=postgres://mailme:<password>@127.0.0.1:5434/mailme APP_BASE_URL=https://mailme.example.com \
     pnpm run setup --account-only
   ```

   It prints a one-time setup link. Open it, choose your password, and connect your mailbox in **Settings →
   Mailboxes**.

4. **Start reading mail:** `deploy/gcp/50-schedule.sh`.

## Your own address

Without `MAILME_DOMAIN`, the service's `run.app` address is the public one. With your own name:

1. **Verify the apex domain** (e.g. `example.com`) in Google Search Console, signed in as the gcloud account.
   - Add a **Domain** property.
   - Add the TXT record it gives you at your DNS provider.
2. **Run `deploy/gcp/45-domain.sh`.** It creates the mapping and prints the record to add, a `CNAME` from your name
   to `ghs.googlehosted.com`.
   - If your DNS provider can proxy traffic (Cloudflare's orange cloud), keep this record **DNS only**.
   - Proxied, the certificate can't be issued.
   - Proxied, every client would also reach the API from the proxy's addresses and share one sign-in rate limit.
3. **Wait.** `45-domain.sh --wait` waits until the Google-managed certificate serves (usually 15–60 minutes).

`APP_BASE_URL` is that one address, so cookies and the Origin check follow it. The `run.app` addresses serve the same
app, but sign-in fails there.

**Two checks after the first sign-in:**

- **No request logs.** This must return nothing. If it returns entries, the exclusion filter did not take.

  ```sh
  gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="mailme-api" AND log_id("run.googleapis.com/requests")' --project "$MAILME_GCP_PROJECT" --limit 5 --freshness 1h
  ```

- **Real client addresses.** Your own IP must appear for your sign-in in
  `select event, ip, created_at from security_audit order by id desc limit 5`, not a Google address. Run the query
  through the proxy. It confirms `TRUST_PROXY=1` behind Google's front end.

## Operations

```sh
P="--project $MAILME_GCP_PROJECT"; R="--region ${MAILME_GCP_REGION:-europe-west1}"
gcloud run jobs execute mailme-tick $P $R --wait                    # a tick now
deploy/gcp/50-schedule.sh --pause                                   # stop the ticks (50-schedule.sh resumes)
gcloud run jobs executions list --job mailme-tick $P $R --limit 10  # recent ticks (exit 1 = a step failed)
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="mailme-tick"' $P --limit 50
gcloud run services logs read mailme-api $P $R --limit 50
```

**Check now.** The button next to the sync light starts `mailme-tick` at once instead of at the next tick, at most
once a minute.
- The API's account holds `roles/run.invoker` on that one job, granted by `40-deploy.sh`. That role can start the job
  as deployed, but has no `runWithOverrides`.
- New mail arrives within about 30 seconds, and becomes tasks at the following tick, after the settle window.

**Release.** Commit, then `30-build.sh`, then `40-deploy.sh`. Migrations run first. A tick that starts during a
release finishes on the image it started with.

**CLI commands** such as `rules:apply`, `user:mfa-reset` or `--new-link` run from your machine, against Cloud SQL:

1. Start the [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy):
   `cloud-sql-proxy --gcloud-auth --port 5434 "$MAILME_GCP_PROJECT:europe-west1:mailme-pg"`.
2. Run the command with that database:
   `DATABASE_URL=postgres://mailme:<password>@127.0.0.1:5434/mailme pnpm cli …`.
   - The password is in the `mailme-database-url` secret.
3. Pause the schedule around commands that sync or drain.

**Backups.** Cloud SQL keeps 7 daily backups plus point-in-time recovery; see `gcloud sql backups list --instance
mailme-pg`. `backup:dump` and the backup-age health check are for the Docker and local setups, so
`BACKUP_MARKER_FILE` is not set here. Keep `.env` and `data/keys` safe on your side as well.

**Choosing the AI.** In **Admin → AI**, pick Claude, OpenAI, Gemini or Grok and paste its key; the models load on
their own. The tick job uses the choice on its next run, with no redeploy. The key is sealed with the credentials
public key: the API stores it but can't open it, only the tick job can. Details: `docs/INSTALL.md`
§ AI provider and API key.

To give the jobs Claude's key from `.env` instead:

1. Set `ANTHROPIC_API_KEY` in `.env`.
2. Run `20-secrets.sh`, then `40-deploy.sh`.

It then wins over a Claude key typed in Admin → AI. Keys for the other providers go through Admin → AI here.

## Static egress IP (optional)

You need this only if your mail server must allowlist a fixed IP. It costs about $6 a month more, and takes four
pieces:

1. a VPC with a /26 subnet in your region;
2. a reserved static IP;
3. a Cloud Router and Cloud NAT using that IP;
4. `--network/--subnet --vpc-egress all-traffic` on **both** the tick job and the API. The API needs it too, because
   it signs in once to check a password when a mailbox is added.

None of this needs a code change.

## Teardown (stops all MailMe billing)

```sh
P="--project $MAILME_GCP_PROJECT"; L=europe-west1; R="--region $L"
gcloud scheduler jobs delete mailme-tick $P --location $L
gcloud run jobs delete mailme-tick $P $R; gcloud run jobs delete mailme-migrate $P $R
gcloud run services delete mailme-api $P $R
gcloud sql instances patch mailme-pg $P --no-deletion-protection && gcloud sql instances delete mailme-pg $P
for s in mailme-database-url mailme-master-key mailme-app-secret mailme-link-secret mailme-credentials-public-key mailme-credentials-private-key mailme-anthropic-api-key; do gcloud secrets delete $s $P; done
gcloud artifacts repositories delete mailme --location $L $P
for a in mailme-api mailme-worker mailme-scheduler; do gcloud iam service-accounts delete "$a@$MAILME_GCP_PROJECT.iam.gserviceaccount.com" $P; done
gcloud logging sinks update _Default $P --remove-exclusions mailme-api-requests
```

Deleting the instance deletes its backups. Dump it first if you want to keep the data.
