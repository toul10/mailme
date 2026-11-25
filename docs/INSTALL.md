# Installing MailMe

This guide takes you from nothing to a running MailMe that reads your mailbox and sends you a daily report.

- [Choose how to run it](#choose-how-to-run-it)
- [Try the demo (2 minutes)](#try-the-demo)
- [Install with Docker (a server with a domain)](#install-with-docker)
- [Install without Docker (Node.js and Postgres)](#install-without-docker)
- [First sign-in](#first-sign-in)
- [AI provider and API key](#ai-provider-and-api-key)
- [Connect a mailbox](#connect-a-mailbox)
- [The daily report](#the-daily-report)
- [Your own rules](#your-own-rules)
- [Ask your mail (an optional chat)](#ask-your-mail)
- [Run it as a service](#run-it-as-a-service)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Monitoring and alerts](#monitoring-and-alerts)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Uninstall](#uninstall)

## Choose how to run it

| You want to… | Use | You need |
|---|---|---|
| See what MailMe does, with sample mail | [the demo](#try-the-demo) | Node.js 22, pnpm |
| Run it for yourself or a team, reachable from your phone | [Docker](#install-with-docker) | a Linux server (or a Mac/PC) with Docker, a domain name |
| Run it on your own computer, or develop on it | [Node.js and Postgres](#install-without-docker) | Node.js 22, pnpm, PostgreSQL 14 or newer |

MailMe has two processes:

- The **API** serves the web app and its API.
- The **worker** reads mail, runs the AI, sends the daily report and does the housekeeping.

Both use one Postgres database. Only one worker may run against a database at a time; a second one waits and
exits.

## Try the demo

The demo is a throwaway MailMe with eight sample e-mails. It runs the free mock AI on an embedded database. You
don't need Postgres, a mailbox or an API key, and it never touches a real installation.

```sh
git clone https://github.com/toul10/mailme.git
cd mailme
npm install -g pnpm@9    # if you don't have pnpm yet
pnpm install
pnpm run demo
```

The demo:

1. builds the web app the first time (about a minute);
2. prints a sign-in address, an e-mail and a password;
3. opens on <http://localhost:3000>.

Each run starts a fresh demo, with sample mail from today and yesterday. **Ctrl+C** stops it. Delete `data/demo`
to remove it.

The demo also writes a preview of the daily report to `data/demo/daily-report.html`.

## Install with Docker

This is the recommended way to run MailMe for real.

- One command starts Postgres, the API, the worker and [Caddy](https://caddyserver.com). Caddy gets an HTTPS
  certificate for your domain from Let's Encrypt.
- Docker restarts everything after a crash or a reboot.

### Before you start

- **A machine that stays on.** A small VPS is enough: 1 vCPU, 1 GB RAM, 10 GB disk. You also need Docker Engine
  with the Compose plugin ([install guide](https://docs.docker.com/engine/install/)). Docker Desktop works for a
  test on a Mac or PC.
- **A domain name for MailMe**, e.g. `mailme.example.com`.
  - Create an `A` record (and `AAAA` for IPv6) pointing it to the server's public IP.
  - Open ports **80** and **443**. Caddy needs both to get the certificate and to serve HTTPS.
- **Git**, to fetch the code and to update it later.

To try it on the same machine without a domain, use the domain `localhost`. The browser then warns about a
self-signed certificate; tell it to continue.

### Run the setup

```sh
git clone https://github.com/toul10/mailme.git
cd mailme
./scripts/docker-setup.sh
```

It asks for:

- **Your domain**, or `localhost` for a test.
- **Your e-mail address.** It is your login, and Let's Encrypt's contact for certificate notices.
- **The timezone.** It defaults to the server's.
- **Your name and your company**, at the end.

It doesn't ask about the AI: after you sign in, you pick the provider and paste its key in Admin → AI. See
[AI provider and API key](#ai-provider-and-api-key).

Then it:

1. writes `.env`, with generated secrets and a database password. Values already in `.env` are kept.
2. builds the image (a few minutes the first time);
3. creates the key pair that seals mailbox passwords, in `data/keys`;
4. starts everything with `docker compose up -d`;
5. creates your organization and your administrator account;
6. prints a **one-time setup link**. Open it to choose your password: see [First sign-in](#first-sign-in).

Run the setup again at any time. It only adds what is missing, and never replaces a secret or a key.

For scripts or CI, `./scripts/docker-setup.sh --yes --domain mailme.example.com --email you@example.com` asks
nothing. Run `./scripts/docker-setup.sh --help` for all options.

### What runs

| Service | What it does |
|---|---|
| `postgres` | PostgreSQL 16. Its data lives in the `pgdata` volume. |
| `migrate` | Applies database migrations once, then exits. `api` and `worker` start only after it succeeds. |
| `api` | Web app and API, behind Caddy. Holds only the *public* key, so it can never read a mailbox password. It gets an AI key only where the optional [chat](#ask-your-mail) is on. |
| `worker` | Reads mail, runs the AI, sends reports. The only service that gets the *private* key. |
| `caddy` | HTTPS on ports 80/443, with automatic certificates. No access log, because one-click report links carry their token in the URL. |

Everyday commands, from the `mailme` folder:

```sh
docker compose ps                     # what is running
docker compose logs -f api worker     # logs (they never contain mail content)
docker compose restart worker         # after changing .env
docker compose down                   # stop everything (your data stays in the volumes)
docker compose up -d                  # start again
```

Run CLI commands through the `worker` service, the one that holds the private key:

```sh
docker compose exec worker node_modules/.bin/tsx src/cli/main.ts help
```

### Without the setup script

If you prefer to do it by hand:

1. `install -m 600 .env.example .env` (readable by you only) and fill it in.
   - Set `MASTER_KEY`, `APP_SECRET`, `LINK_SECRET`, `POSTGRES_PASSWORD`, `MAILME_DOMAIN` and `ACME_EMAIL`.
   - Docker sets `DATABASE_URL` and `APP_BASE_URL` itself.
2. Create the key pair in `data/keys`. You can use the image:
   `docker compose build && docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/data/keys:/keys" mailme:latest node_modules/.bin/tsx src/cli/main.ts keys:generate --out-dir /keys`.
   - On Linux the containers run as uid 1000 and must be able to read both files: `sudo chown 1000:1000 data/keys/*.pem`.
3. Start it: `docker compose up -d`.
4. Create your account: `docker compose exec api node_modules/.bin/tsx scripts/setup.ts --account-only`.

## Install without Docker

Use this on your own computer, or on a server where you run Node.js and Postgres yourself.

### 1. Prerequisites

You need Node.js **22 or newer**, pnpm **9 or newer** and PostgreSQL **14 or newer**.

**macOS (Homebrew)**

```sh
brew install node pnpm postgresql@16
brew services start postgresql@16
```

**Debian / Ubuntu**

```sh
# Node.js 22 from NodeSource (or use nvm / fnm)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs postgresql
sudo npm install -g pnpm@9
# a Postgres role for your login that may create the database
sudo -u postgres createuser --createdb "$USER"
```

On Debian and Ubuntu, Postgres lets your login in without a password only over its local socket. The setup
notices the socket and suggests `postgres:///mailme?host=/var/run/postgresql` as the database.

**Windows:** use [WSL 2](https://learn.microsoft.com/windows/wsl/install) with Ubuntu and follow the Debian steps,
or use Docker Desktop and [install with Docker](#install-with-docker).

Then fetch MailMe and install its dependencies:

```sh
git clone https://github.com/toul10/mailme.git
cd mailme
pnpm install
```

### 2. Run the setup

```sh
pnpm run setup
```

Type `pnpm run setup` with `run`: plain `pnpm setup` is pnpm's own command.

The setup asks a few questions; each has a default in brackets, so Enter accepts it.

| Question | Default | Notes |
|---|---|---|
| Database | `postgres://localhost:5432/mailme` (Debian/Ubuntu: the local socket) | It creates the database if it doesn't exist. `pglite://./data/pglite` is an embedded database for a quick look around. It allows one process only, so no worker: [see below](#embedded-database). |
| Web address | `http://localhost:3000` | The address you open in the browser. Anything other than `localhost` needs HTTPS: [see below](#https-for-a-local-install). |
| Timezone | your computer's | Used for due dates and the report time. |
| Your e-mail, name, company, company domains | — | Your account is the administrator of this installation. Mail from your company's domains counts as a colleague. |

It doesn't ask about the AI. It writes `AI_MODE=auto`, and after you sign in you pick the provider and paste its key
in Admin → AI: see [AI provider and API key](#ai-provider-and-api-key). `--ai-mode mock` turns AI off.

It then:

1. writes `.env`, with owner-only permissions and generated secrets;
2. creates the key pair in `data/keys`;
3. creates the tables;
4. creates your account and prints a one-time setup link;
5. builds the web app.

Like the Docker setup, it is safe to run again: it never replaces a value in `.env`, a key or an account. Run
`pnpm run setup --help` for the options. `--yes` asks nothing, for scripts and CI.

### 3. Start MailMe

```sh
pnpm start:api       # terminal 1: the web app on http://localhost:3000
pnpm start:worker    # terminal 2: reads mail, runs the AI, sends the report
```

Open the setup link the setup printed, and continue with [First sign-in](#first-sign-in). To keep MailMe running
after you close the terminals, see [Run it as a service](#run-it-as-a-service).

### Embedded database

With `DATABASE_URL=pglite://./data/pglite`, Postgres runs inside the MailMe process, so you don't need a Postgres
server. Only one process can open it at a time. You can run the API and look around, but not the worker, so no mail
is read and no report goes out. To read real mail, set a Postgres `DATABASE_URL` in `.env` and run
`pnpm run setup` again.

### HTTPS for a local install

Browsers keep the sign-in cookie only over **HTTPS**, or over plain http on `localhost`. To open MailMe from another
device, such as your phone, put a reverse proxy with HTTPS in front of it. With [Caddy](https://caddyserver.com) on
the same machine:

```
mailme.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Then set `APP_BASE_URL=https://mailme.example.com` in `.env` and restart the API. The default
`TRUST_PROXY=loopback` trusts a proxy on the same machine. If the proxy runs elsewhere, read the comment above
`TRUST_PROXY` in `.env.example`.

## First sign-in

1. Open the **setup link** the setup printed. It works once, for 72 hours, and only for your account.
2. Choose a password of at least 12 characters.
3. Scan the QR code with an authenticator app, such as Google Authenticator, Microsoft Authenticator, 1Password,
   Bitwarden or Aegis, and type the 6-digit code. MailMe asks for a code at every new sign-in. You can mark a device
   as trusted.

If you lose the link, your password or your phone, you need a new setup link:

```sh
pnpm run setup --new-link you@example.com
docker compose exec api node_modules/.bin/tsx scripts/setup.ts --new-link you@example.com   # Docker
```

Using a new link sets a new password and a new two-step sign-in, and signs out every other session.

To add colleagues, open **Admin** in the web app. Under **New account**, choose **Create and get link**, and send
each person their own setup link.

Next, before you connect a mailbox, choose the AI: [AI provider and API key](#ai-provider-and-api-key).

## AI provider and API key

MailMe reads each new message with the AI provider you choose: **Claude** (Anthropic), **OpenAI**, **Gemini**
(Google) or **Grok** (xAI).

> **Claude is the measured provider.** MailMe's prompt and its eval set were tuned and measured with Claude. The
> Gemini adapter has also been run against the live API (see [Quality](#quality)). The OpenAI and Grok adapters are
> tested only against fake responses built from the providers' documentation, not yet against the live APIs. Start
> any of them on one mailbox and check the first tasks. If a provider rejects MailMe's requests (for example its
> structured-output schema), AI pauses for all mailboxes and Admin → AI shows it: choose another provider or
> **Off**, and mail waits meanwhile.

- With no AI chosen and no key, the **free mock** runs: simple built-in rules, no network, rough results.
- Once a provider is chosen, a missing key **pauses AI** until it is fixed. So do a key the worker can't decrypt
  (for example after the credentials keys were replaced) and a missing model. Admin → AI then shows a red banner
  with the fix, and mail waits instead of being read by the mock.

Choose the AI **before you connect a mailbox**. The first sync reads the last weeks of mail (`BACKFILL_DAYS`, 21 by
default) with whatever AI runs at that moment.

### Add your key in Admin → AI

1. Create an API key at your provider, and set a monthly spending limit there:
   - Claude: [Anthropic Console](https://console.anthropic.com/settings/keys)
   - OpenAI: [OpenAI Platform](https://platform.openai.com/api-keys)
   - Gemini: [Google AI Studio](https://aistudio.google.com/apikey)
   - Grok: [xAI Console](https://console.x.ai)
2. In MailMe, open **Admin** and its first section, **AI provider**. Pick the provider and paste the key.
3. The models load on their own a moment later. Loading them also checks the key: a wrong key shows, for example,
   "OpenAI rejected this key". The model in use, or else the newest one, is preselected.
4. Choose **Save**. The worker uses the new choice on its next run, within a few minutes. The status line at the top
   of the section shows what the worker runs with; **Refresh status** reads it again.

The worker reloads the model list of the key in use once a day, so new models appear within a day. To reload it now,
paste the key again. If a reload fails, the older list stays and the worker tries again an hour later.

**Remove key** deletes a key typed here. If its provider is the one in use, AI pauses until you add another key or
choose another provider; MailMe asks first. **Off (free mock)** turns AI off from the browser.

### Check it with one invented email

Listing the models proves the key, but not the billing behind it, nor that the model accepts MailMe's request. One
command does, before any real mail is read:

```sh
pnpm cli ai:check          # Docker: docker compose exec worker node_modules/.bin/tsx src/cli/main.ts ai:check
```

It sends one invented email (a customer asks for a quote by Friday; nobody in it is real) through the provider and
model chosen in Admin → AI, and shows the answer, the time it took and what it cost: one paid call, a few cents at
most. It reads no mail and changes nothing. When the call fails it says why and what to do about it. Run it after
you change the provider, the model or the key: a model that refuses the request would otherwise pause AI for every
mailbox at its first real message.

### Or: a key in the environment

The worker also reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `XAI_API_KEY` from its
environment (`.env`):

- Only the worker reads them. Docker blanks them for the API and the migrations.
- For the chosen provider, an environment key wins over a key typed in Admin → AI. Admin → AI then shows it as
  "From the server environment", with its last 4 characters only, and can't change it.
- With no choice saved in Admin → AI, only `ANTHROPIC_API_KEY` turns AI on by itself (Claude, with `AI_MODEL`). A
  `.env` with only `OPENAI_API_KEY`, say, stays on the free mock until you pick OpenAI in Admin → AI.
- Admin → AI learns about an environment key from the worker. Start or restart the worker, then reload the page.

After you change `.env`, restart the worker: `docker compose up -d` with Docker, otherwise restart
`pnpm start:worker`.

### Turning AI off

- **From the browser:** Admin → AI → **Off (free mock)**, then **Save**.
- **On the server:** set `AI_MODE=mock` in `.env` and restart the worker. This is the kill switch:
  - it wins over every choice in Admin → AI;
  - the worker calls no AI provider at all, not even to list models;
  - Admin → AI still shows an environment key's last 4 characters, but that key's model list stays empty.

| `AI_MODE` | What it does |
|---|---|
| `auto` (default) | Admin → AI decides. With nothing chosen there: Claude when `ANTHROPIC_API_KEY` is set, otherwise the free mock. Once a provider is chosen, a missing key pauses AI. |
| `mock` | The kill switch: AI is off, whatever Admin → AI says. |
| `claude` | Older `.env` files. Like `auto`, but with no AI chosen it means Claude: without `ANTHROPIC_API_KEY`, AI pauses. |

### Costs and limits

You pay the provider for each message it reads (usage-based); the mock is free. Whatever the provider, MailMe limits
each mailbox to `AI_DAILY_CALL_CAP` calls (default 150) and about `AI_DAILY_USD_CAP` dollars (default 10) a day. At
a limit it pauses AI for that mailbox until local midnight.

How the dollar limit counts each call:

| Provider | Cost counted |
|---|---|
| Claude | From Anthropic's published prices. |
| Grok | The exact cost, which xAI reports with each call. |
| Gemini | From Google's published prices for the models in MailMe's price table (`src/ai/pricing.ts`; where an increase is already announced, the higher price). Any other Gemini model is counted like OpenAI. |
| OpenAI | It reports no price, so MailMe counts a deliberately high $10 per million input tokens and $50 per million output tokens. |

The call limit works the same for every provider.

### Gemini: prepaid credits and thinking

- A Gemini key from AI Studio can run on prepaid credits. When they are used up, every call answers HTTP 402. MailMe
  then waits and asks again every five minutes; nothing is paused for good, and the queue continues by itself once
  you buy credits. `pnpm cli ai:check` tells you when this is the reason.
- `GEMINI_THINKING_LEVEL` in `.env` (`minimal`, `low`, `medium`, `high` or `xhigh`) sets how hard the model thinks.
  Thinking is billed as output. Leave it out for the model's own default. The levels a model accepts differ, and a
  refused one fails every call, so run `pnpm cli ai:check` after you set it.

### Quality

MailMe's extraction quality was measured with Claude, in the evaluations in `eval/`. The other providers run the
same prompt. The Gemini adapter has also been run against the live API (`gemini-3.8-flash`, November 2026). The
OpenAI and Grok adapters follow those providers' documentation and have not been run against their live APIs yet.
Whatever you choose, run `pnpm cli ai:check` first and check the first tasks before you rely on them. To measure a
model on the evaluation cases yourself (paid calls):

```sh
GEMINI_API_KEY=… pnpm eval --extractor gemini --model gemini-3.8-flash --runs 1 --yes-spend --max-usd 2
```

### How the key is kept

- The API uses a pasted key only to list its models. Then it seals the key with the installation's credentials
  public key, like a mailbox password. From then on the API can't open it; only the worker, which holds the private
  key, can.
- A saved key is never shown again: Admin → AI shows only its last 4 characters. To replace it, paste a new one.
- Every change of provider, model or key is written to the security audit log (`security_audit`).
- The key goes from your browser to MailMe only inside a request body over HTTPS, never in a URL. The web app never
  stores it in the browser.
- These keys are the worker's. The API holds an AI key of its own only where the optional chat is switched on: see
  [Ask your mail](#ask-your-mail).

### Privacy

Mail text is sent to the provider you choose for processing. Before you connect mailboxes, check that this fits your
privacy rules and your company's. The text is screened first:

- mail that the built-in filters recognise as newsletters, notifications, auto-replies or spam never reaches the AI;
- card numbers, IBANs and passwords are masked before the text leaves the server;
- the `DENY_LIST` setting keeps chosen senders away from the AI.

The optional chat is off by default. Where it is on, it sends mail text to Google's Gemini API when a user asks a
question, whatever provider reads the mail: see [Ask your mail](#ask-your-mail).

## Connect a mailbox

MailMe reads a mailbox over **IMAP** with a password. It works with almost every mail provider. It does not support
OAuth sign-in yet: see [Known limitations](#known-limitations).

In the web app, open **Settings**, and next to **Mailboxes** choose **+ Add**:

1. **Email address**: your e-mail address.
2. **IMAP server**: see the table below. The port is **993**: MailMe uses TLS only and checks the certificate.
3. **Username**: leave it empty when your login is your e-mail address.
4. Choose **Add**. Then, on the mailbox's page, enter the **password** and choose **Test & save**. For most big
   providers this must be an **app password** (see below), not your normal password.

MailMe signs in once to check the settings and lists your folders. It then stores the password sealed with the
public key: only the worker can open it, never the API.

Common settings:

| Provider | IMAP server | SMTP (for the report, optional) | Password |
|---|---|---|---|
| Gmail / Google Workspace | `imap.gmail.com` | `smtp.gmail.com`, 587 | An [app password](https://myaccount.google.com/apppasswords). Needs 2-Step Verification. A Workspace admin may have to allow app passwords. |
| iCloud Mail | `imap.mail.me.com` | `smtp.mail.me.com`, 587 | An [app-specific password](https://support.apple.com/en-us/102654) |
| Yahoo Mail | `imap.mail.yahoo.com` | `smtp.mail.yahoo.com`, 587 | An app password (Account security) |
| Fastmail | `imap.fastmail.com` | `smtp.fastmail.com`, 587 | An app password (Settings → Privacy & Security) |
| Your web host (cPanel, Plesk, …) | usually `mail.yourdomain.com` | usually the same, 587 | Your mailbox password |

Good to know:

- **Read-only.** MailMe opens folders read-only. It never marks mail as read, moves it or deletes it. The only thing
  it writes is the daily report, added to your inbox (see below).
- **History.** On the first connection it reads the last 21 days (`BACKFILL_DAYS`, up to 90).
- **The shadow week.** For the first 7 days MailMe reads your mail and fills the task list, so you can check how well
  it reads your mail before you rely on it. The daily report starts after that week.
- **Folders.** Inbox, Sent and Archive are read by default; Junk, Trash and Drafts are not. Change this per folder
  on the mailbox's page in Settings.
- **Failed sign-ins.** If the password is rejected, MailMe stops trying until you enter a new one. Many providers
  block an address after a handful of failed sign-ins.
- **A mistake in the settings.** A mistyped address, server, port or username is corrected on the mailbox's page,
  under **Edit connection settings**. Saving a change removes the stored password: you enter it again and it is
  tried against the new settings. Once a mailbox holds mail, its address and username stay as they are; for another
  address, add a new mailbox.
- **Several mailboxes.** With two or more mailboxes of your own, a switch above Today, the task lists and
  [Ask your mail](#ask-your-mail) shows all of them together or one at a time. A task you enter by hand can be
  given to one of them.
- **Public servers only.** The web app accepts only public mail servers, as an SSRF guard. A server on your own
  network can be added from the command line: `pnpm cli mailbox:add --user you@example.com --address you@example.com --host mail.internal.example`.
- **Sent mail matters.** MailMe learns what *you* promised from your sent mail. If your sent mail never reaches the
  server (some Outlook POP3 setups), see `tools/outlook-agent`.

## The daily report

Every business day, at **07:30** in your timezone, MailMe adds a short report to your inbox. It answers three
questions: *What do I need to do? What am I waiting for? What did I promise, and by when?* Each line has one-click
links to mark a task done, snooze it or open it.

- By default the report is placed in your inbox over IMAP, without sending any mail. To have it sent over SMTP
  instead, or to change the time, use the CLI:
  `pnpm cli user:update --user you@example.com --digest-time 08:00 --digest-delivery smtp`.
- Preview today's report without sending it: `pnpm cli digest:preview --user you@example.com`.

## Your own rules

Tell MailMe what to ignore, what to forward and what a colleague has already handled, e.g. "mail about orders that
has orders@ in Cc: ignore it". Rules are a JSON file that you import with `pnpm cli rules:import`; then you switch
them on and off in the web app under **What matters to me**. [docs/rules](rules/README.md) explains the format and
every kind of rule.

Your suppliers are the one kind of rule that you write in the web app itself. Open **What matters to me →
Suppliers** and give each supplier a name and the address or domain they write from: their open tasks are then
gathered under that name. See [Suppliers](rules/README.md#suppliers).

## Ask your mail

An optional chat, **off by default**. Where it is on, every user gets an **Ask your mail** page. They ask about
their own mail and tasks, for example "What is waiting for my reply?" or "What did George ask me for last week?",
and get an answer that names the messages and tasks it was taken from. It can also draft a reply for them to copy.
It only reads: it sends no mail and changes no task.

Read this section before you turn it on, because the chat changes two things about your installation:

- **The API gets an AI key.** Without the chat, only the worker calls an AI, and the API can't open the keys of
  Admin → AI. The chat answers while the user waits, so it runs in the API, with a key of its own in the API's
  environment: `CHAT_API_KEY`.
  - If the API is ever broken into, that key can be used to spend your credit at the provider. Give the chat a key
    of its own, so that you can revoke it without stopping the mail from being read, and set a spending limit at
    the provider.
  - The private key that opens mailbox passwords stays with the worker, as before.
- **Mail text goes to Google when a user asks.** Each question sends the question, the earlier turns of the
  conversation and what the lookups found (search hits, whole conversations) to the Gemini API. The chat works with
  **Gemini only**, whatever provider you chose in Admin → AI.

### Turn the chat on

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Set it up in `.env`:

   ```sh
   CHAT_MODE=gemini
   CHAT_API_KEY=…                  # the chat's own key
   CHAT_MODEL=gemini-3.8-flash     # a model of that key
   CHAT_THINKING_LEVEL=low         # optional: how hard the model thinks (see "Speed and cost" below)
   ```

3. Check it with one invented question over an invented mailbox. It makes a few paid calls, about a cent together.
   It reads no mail and no database:

   ```sh
   pnpm cli chat:check
   ```

   It prints what the model looked up, its answer, the time and the cost. The answer should name the invented
   customer's message as a source. When a call fails it says why and what to do about it.
4. Restart the API (`pnpm start:api`). **Ask your mail** now appears in the menu.

With Docker, restart first and check afterwards. Run the check in the **api** container: the worker's container
never gets the chat's key.

```sh
docker compose up -d
docker compose exec api node_modules/.bin/tsx src/cli/main.ts chat:check
```

On Google Cloud, see *Ask your mail* in [deploy/gcp](../deploy/gcp/README.md#operations).

With `CHAT_MODE=gemini` the API does not start without `CHAT_API_KEY` and `CHAT_MODEL`: its log names the one that
is missing, and the web app is down until you fix it. `CHAT_MODE=mock` is for development: it answers from keywords
and calls nobody.

### What the chat reads

The model can only look things up, and only for the user who asks: their own mailboxes and their own task list.
Every lookup runs in a read-only database transaction. The model has nothing that sends, deletes or changes.
A user with several mailboxes who looks at one of them asks about that mailbox only: its mail and the tasks made
from it.

It is never shown:

- spam and phishing, drafts and deleted mail, and the reports MailMe itself delivers;
- folders marked private, and mail to or from the `DENY_LIST`;
- senders the user chose to ignore, including their older mail;
- mail the AI classified as personal;
- mail the AI has not analysed yet (the model is told how much of that there is).

These are decided at the time of the question: the lists as they are now, the folders as the last sync saw them.
Two things to know about that:

- MailMe can't know what happened to a message on the mail server after it was read, in a folder that is not
  synced. A message deleted there, or moved into a private folder, stays readable until a sync sees it in the trash
  or the spam folder. The task list has the same limit.
- A user who switched their own spam rule off ([docs/rules](rules/README.md)) gets the spam folder and suspected
  phishing read like other mail, as in the task list.

Also:

- Card numbers, IBANs and passwords are masked in the stored text, so the chat never sees them either.
- The text of a message is kept for `BODY_RETENTION_DAYS` (90 days). Older messages show their subject, people and
  date only, and the model is told so.
- A message that names the user or their organization as its sender, while the mail server's own checks say the
  sender was not authenticated, is marked as unconfirmed: for the model, and on the source card the user sees.
- Mail text is data for the model, never instructions. A mail that tries to give the model orders can at worst
  change what an answer says, not what MailMe does. That is one reason every answer names its sources.

### What is stored

Nothing of a conversation is stored on the server. It lives in the browser tab and is gone when the tab closes, when
the user signs out or when they choose **New conversation**. The server writes one `chat.ask` row per question to
`security_audit`, with counts only: the model, the calls and lookups, the tokens, the cost, the time and how the
question ended. Never the question, the answer or anything that was read.

To see what the first real questions cost and how long they take:

```sql
select created_at, detail->>'outcome' as outcome, detail->>'calls' as calls, detail->>'lookups' as lookups,
       detail->>'costUsd' as usd, detail->>'ms' as ms
from security_audit where event = 'chat.ask' order by created_at desc limit 20;
```

### Limits

- **Per question:** 4 rounds of lookups and 100 seconds in all. One lookup may keep the database busy for 10 seconds
  at most; after that the model is told to narrow it.
- **Per user:** one question at a time and 20 questions in 10 minutes (both counted in the API's memory, so per API
  process), and `CHAT_DAILY_QUESTION_CAP` questions a day (100 by default).
- **For everybody together:** `CHAT_DAILY_USD_CAP` dollars a day (3 by default), counted from the `chat.ask` rows
  with MailMe's price table (`src/ai/pricing.ts`). A model call that was stopped before it answered is counted with
  an estimate of its input, so stopping a question is no way around the limit.
- **Search speed.** A search reads the text of the user's mail; it doesn't use an index. Measured on a laptop with
  PostgreSQL 16 and 30,000 messages of 2 KB: about 0.6 seconds for one word, 1.5 seconds for three alternatives.
- **The provider's own filter.** A message that Google's safety filter refuses ends that one question with a
  sentence instead of an answer.

### Speed and cost

A question takes several model calls, five at most: the model looks things up, reads what came back and then
answers. `CHAT_THINKING_LEVEL` decides most of the waiting time. Thinking is billed as output, and the levels a
model accepts differ, so run `pnpm cli chat:check` after you change it.

What was measured, and what was not:

- In November 2026 the chat was run against the live Gemini API with `gemini-3.8-flash`, on invented mail. At `low`
  the check question took 10 to 11 seconds and cost about $0.013. 23 further questions were all answered, in 2 to
  13 seconds (median 9), for $0.011 each on average. At `medium`, and with the level unset, the check question
  took 19 seconds and cost about $0.02. That model refused `minimal`.
- That run used a wording of the prompt that answers in Greek when the language of a question is unclear. The
  published prompt answers in English then, and differs in some examples. **The published wording has not been run
  against the live API.** Run `chat:check` and ask a few questions of your own before you offer the chat to your
  users.
- No other Gemini model was tried, and no other provider is supported.

### Turn the chat off

Set `CHAT_MODE=off` in `.env` (or remove the line) and restart the API. The menu entry disappears and
`POST /api/chat` answers 404. If the chat stays off, also remove `CHAT_API_KEY` from `.env` and revoke the key at
the provider.

### When a question fails

The user sees a plain sentence. The API log gets one line, `chat: the model call failed`, with a code and a kind,
never the question:

| Kind | Meaning |
|---|---|
| `no_credit` | The key's prepaid credits are used up. |
| `config` | The provider refuses the key, the model id or the request. |
| `unavailable` | A rate limit, an outage or a timeout. |

`pnpm cli chat:check` reproduces it and says what to do. The worker is not affected: it keeps reading mail with its
own key.

## Run it as a service

The Docker install already restarts everything on its own. For a Node.js install:

**Linux (systemd).** Create `/etc/systemd/system/mailme-api.service`. Change `User` and the paths to match your
system.

```ini
[Unit]
Description=MailMe API
After=network-online.target postgresql.service

[Service]
User=mailme
WorkingDirectory=/opt/mailme
ExecStart=/usr/bin/node --import tsx src/server/main.ts
Restart=on-failure
TimeoutStopSec=35

[Install]
WantedBy=multi-user.target
```

Create `mailme-worker.service` the same way, with three differences:

- `ExecStart=/usr/bin/node --import tsx src/worker/main.ts`;
- `TimeoutStopSec=120`, so the worker can finish the message in flight;
- `Restart=always`. The worker exits on purpose when the database restarts, so systemd must always start it again.

Then run `sudo systemctl daemon-reload && sudo systemctl enable --now mailme-api mailme-worker`. Both services read
`.env` from `WorkingDirectory`.

**macOS (launchd).** `deploy/mac/launchd.sh install` starts the API and the worker at login and restarts them after a
crash.

## Backups

Back up two things, separately:

1. **The database.** `pnpm cli backup:dump` writes a `pg_dump` to `BACKUP_DIR` (default `./data/backups`) and prunes
   dumps older than `BACKUP_KEEP_DAYS`. It needs the `pg_dump` program. In Docker:
   `docker compose exec worker node_modules/.bin/tsx src/cli/main.ts backup:dump`. That writes into the worker's
   `appdata` volume, so copy it off the server.
   - Run it daily, e.g. from cron. If `BACKUP_MARKER_FILE` is set, the health check alerts when the last backup is
     older than 26 hours.
2. **`.env` and `data/keys`.** Without `MASTER_KEY`, two-step sign-in has to be set up again. Without the private
   key, every mailbox password has to be entered again. Keep both files somewhere safe, apart from the database
   dumps: a database backup together with the key would expose every mailbox password.

To restore, load the dump with `pg_restore` into an empty database. Then put `.env` and `data/keys` back, and start
MailMe.

## Upgrading

```sh
git pull
./scripts/docker-setup.sh            # Docker: rebuilds the image, migrates, restarts
```

Without Docker:

```sh
git pull
pnpm install
pnpm build:web
pnpm cli db:migrate
# then restart the API and the worker
```

Migrations only move forward. Take a backup before you upgrade.

**From a version without Admin → AI.** The setup used to write `AI_MODE=mock`, and an upgrade keeps your `.env` as
it is. `mock` is now the kill switch, so Admin → AI can't turn AI on while it is set. To choose the AI there, set
`AI_MODE=auto` in `.env` and restart the worker. `AI_MODE=claude` works as before: with nothing chosen in
Admin → AI it runs Claude with `ANTHROPIC_API_KEY`.

## Monitoring and alerts

- `/health` answers `{"ok":true}` while the API is up. Use it for an uptime check.
- `ALERT_WEBHOOK_URL` sends alerts to a channel that doesn't depend on your mail server: an
  [ntfy](https://ntfy.sh) topic or any JSON webhook. Alerts cover a mailbox that can't sign in, a stuck queue, a
  paused AI, a report that wasn't delivered, a full disk and old backups.
- `HEALTHCHECK_PING_URL` is pinged after every sync cycle and every report. It works with dead-man's-switch services
  such as healthchecks.io, which alert you when the pings stop.
- **Settings** in the web app shows the state of each mailbox, the last sync and any messages that couldn't be
  analysed.

## Troubleshooting

| Problem | What to do |
|---|---|
| `Can't reach Postgres` during setup | Start Postgres (`brew services start postgresql@16`, or `sudo systemctl start postgresql`), or fix `DATABASE_URL` in `.env`. |
| The sign-in page reloads, or you are signed out at once | You are on plain http with an address other than `localhost`. Use HTTPS, as in [HTTPS for a local install](#https-for-a-local-install). |
| The setup link says it expired or was used | Get a new one: `pnpm run setup --new-link you@example.com`. |
| A mailbox shows "Sign-in failed" | Sign in to webmail with the same password to check it, then enter it again in Settings. For Gmail, iCloud and Yahoo use an app password. If the password is right, check the address and the username on the mailbox's page: **Edit connection settings** corrects them. |
| No tasks appear | Is the worker running? Check its log and the mailbox's last sync in Settings. With the free mock (no AI chosen and no key, or `AI_MODE=mock`) only simple phrasings are recognised: see Admin → AI. |
| "AI is paused" | For one mailbox: a daily limit was reached, and it resumes at local midnight. For every mailbox, Admin → AI shows a red banner with the cause: no usable key for the chosen provider, a key the worker can't decrypt, no model, or the provider refused the key, the billing or a spending limit. Paste a working key, choose another provider or turn AI Off there, and save: that resumes AI. After an internal error, run `pnpm cli ai:resume` once the cause is fixed. |
| "Ask your mail" is not in the menu, or says the AI isn't available | The chat is off unless `CHAT_MODE` is set: see [Ask your mail](#ask-your-mail). When it is on and fails, `pnpm cli chat:check` says why: the key, the credits or the model. |
| Some messages couldn't be analysed | `pnpm cli messages:parked` lists them. `pnpm cli messages:retry` tries them again. |
| `Another worker holds the lock` | Only one worker may run against a database. Stop the other one. |
| Anything else | `pnpm cli health:run --dry` runs every health check and prints the result. The logs show ids and error codes, never mail content. |

`pnpm cli help` lists every CLI command. `pnpm cli <command> --help` shows that command's options.

## Known limitations

- **Business days follow the Greek public-holiday calendar.** "In 3 business days", and the days with no report,
  skip Greek holidays such as Orthodox Easter. Holy Spirit Monday is optional per organization. Other countries'
  holidays are not built in yet.
- **The default timezone is `Europe/Athens`.** The setup asks for yours. You can also set `DEFAULT_TIMEZONE`, and
  give each organization its own timezone.
- **The mail understanding is tuned on Greek and English business mail.** That covers reply and forward headers,
  dates such as "by Friday" or «έως Παρασκευή», out-of-office replies and Greeklish. The AI reads other languages too,
  but the built-in filters and the mock AI know only these two.
- **Password (IMAP) sign-in only.** There is no OAuth. Microsoft 365 and Outlook.com mailboxes, which generally
  require OAuth for IMAP, can't be connected directly yet. Gmail works with an app password.
- **One worker per database.** One worker handles every mailbox of the installation.
- **The Outlook agent** (`tools/outlook-agent`) is untested.

## Uninstall

- **Docker:** run `docker compose down -v`. `-v` also deletes the database volume, so take a backup first if you
  want one. Then delete the folder.
- **Node.js:** stop the processes and delete the folder. Drop the database with `dropdb mailme`.
- **The demo:** delete `data/demo`.
