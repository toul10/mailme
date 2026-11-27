# MailMe

**Your mailbox, turned into a short task list.** MailMe reads your e-mail and finds what people asked of you, what
you promised and what you are waiting for. Each business morning it sends you a short report that answers three
questions:

- **What do I need to do?**
- **What am I waiting for?**
- **What did I promise, and by when?**

It is self-hosted: one small server, your own database, and your own API key for the AI: Claude, OpenAI, Gemini or
Grok.

```
IMAP (read-only) ─┐                                       ┌─ web app: tasks, the sender's own words, one-tap fixes
Ingest API ───────┼─► ingest → filters → conversations ─► queue ─► AI extraction ─► reconciler ─► PostgreSQL
Outlook agent ────┘        (rules, no AI)         (per mailbox, in order)     (who may change what) └─ daily report
```

## What it does

- **Reads mail without touching it.** MailMe connects to your mail server over IMAP and opens folders read-only. It
  never marks mail as read, moves it or deletes it.
- **Keeps the AI on a short leash.** Built-in filters drop newsletters, notifications, auto-replies and spam
  before any AI call.
  - The AI only *proposes* changes, citing the sentence it read them from.
  - Deterministic code decides what is applied. A customer's e-mail can't close your tasks, and a request you
    were only copied on doesn't become your task.
- **Shows the evidence.** Every task shows the sender's own words, quoted, so you can check the AI's reading at a
  glance.
- **Asks when unsure.** When the AI isn't sure, you get a plain question with two answers, such as "Done already?",
  instead of a silent change.
- **Learns your rules.** "Mail about orders that has orders@ in Cc: ignore it." "A colleague already replied: close
  it." See [docs/rules](docs/rules/README.md).
- **Shows your tasks supplier by supplier.** Name your suppliers once, each with the address or domain they write
  from, and their open tasks are gathered under each name. See [Suppliers](docs/rules/README.md#suppliers).
- **Sends a daily report.** It is placed in your inbox at 07:30, with one-click buttons to mark tasks done or snooze
  them.
- **Shows what it is doing, and what it costs.** A sync bar says what the worker is doing right now: checking for new
  mail, analysing 25 of 65, or paused until midnight and why. **Settings → AI costs** shows the AI's cost day by day,
  per mailbox and model, next to each mailbox's daily limits.
- **Answers questions about your mail (optional).** "What is waiting for my reply?" "What did George ask me for last
  week?" The chat reads only your own mail and tasks, changes nothing, and names the messages behind every answer.
  It is off by default: see [Ask your mail](docs/INSTALL.md#ask-your-mail).
- **Understands Greek and English business mail.** That includes Greeklish, Outlook and Gmail reply chains, and dates
  such as "by Friday" or «έως Παρασκευή».

## Quick start

**Try it with sample mail.** You need Node.js 22 or newer. It runs without a mailbox, an API key or Postgres:

```sh
git clone https://github.com/toul10/mailme.git && cd mailme
npm install -g pnpm@9           # if you don't have pnpm yet
pnpm install
pnpm run demo                   # then open http://localhost:3000 and sign in with the printed password
```

**Install it on a server with Docker**, with HTTPS included:

```sh
git clone https://github.com/toul10/mailme.git && cd mailme
./scripts/docker-setup.sh       # asks for your domain and e-mail, starts everything, prints your setup link
```

**Install it with Node.js and Postgres:**

```sh
git clone https://github.com/toul10/mailme.git && cd mailme
pnpm install
pnpm run setup                  # writes .env, keys, database, your account; prints your setup link
pnpm start:api                  # and in a second terminal: pnpm start:worker
```

Then:

1. Open the setup link and choose your password; MailMe also has you set up two-step sign-in.
2. Pick the AI and paste its key in **Admin → AI** (Claude, OpenAI, Gemini or Grok). Its models load on their own.
3. Connect your mailbox in **Settings → Mailboxes**.

**[docs/INSTALL.md](docs/INSTALL.md)** is the full guide. It covers:

- connecting Gmail and other providers;
- the AI provider and its key;
- HTTPS, running as a service, backups and upgrades;
- troubleshooting and known limitations.

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Installing, connecting a mailbox, running and maintaining MailMe |
| [docs/architecture.md](docs/architecture.md) | How it works: the pipeline, the processes, the data model, the security model |
| [.env.example](.env.example) | Every setting, with its default and what it does |
| `pnpm cli help` | The command-line tool: mailboxes, imports, previews, rules, health checks, backups |
| [docs/rules](docs/rules/README.md) | Your own mail rules: the format, every kind of rule, an example |
| [tools/outlook-agent](tools/outlook-agent/README.md) | Optional Windows agent that uploads Outlook's Sent Items (untested) |
| [deploy/gcp](deploy/gcp/README.md) | Running on Google Cloud: Cloud Run + Cloud SQL, started on demand |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |

## Privacy and security

The code enforces these rules:

- **Mail server:**
  - IMAP over verified TLS only;
  - folders opened read-only, bodies read with `BODY.PEEK`;
  - after repeated failed sign-ins MailMe stops trying until you enter the password again, so it can't get your
    address banned.
- **Mailbox passwords:** sealed with X25519 + AES-GCM.
  - The web/API process holds only the public key and can never read a password.
  - Only the worker holds the private key, as a file that stays out of the database and its backups.
- **Sign-in:**
  - argon2id passwords and TOTP two-step sign-in;
  - HTTP-only session cookies, with only a hash of each session token in the database;
  - one-click report links that are signed and single-purpose.
- **Logs and alerts:** ids, counts, durations and error codes only. Never subjects, bodies, addresses, prompts or
  model output.
- **AI:**
  - mail text is data, never instructions;
  - card numbers, IBANs and passwords are masked before any AI call;
  - daily call and spend caps per mailbox;
  - a key typed in Admin → AI is sealed like a mailbox password: only the worker can open it, and only its last 4
    characters are ever shown;
  - `AI_MODE=mock` is the kill switch: the worker calls no AI provider at all (a key pasted in Admin → AI is still
    checked against the provider's free model list).
- **Chat ("Ask your mail"):** off by default (`CHAT_MODE`).
  - Where it is on, a signed-in user asks about their own mail and tasks. The model only reads, and only that
    user's data.
  - It is never shown spam, phishing, drafts, deleted mail, private folders, mail to or from the deny-list, senders
    the user ignores, mail classified as personal, or mail the AI has not analysed yet.
  - Nothing of a conversation is stored on the server: one audit row per question, with counts and cost only.
  - It is the one feature that gives the API process an AI key, and it sends mail text to Google's Gemini API
    whatever provider reads the mail. Read [Ask your mail](docs/INSTALL.md#ask-your-mail) before you turn it on.
- **Retention:**
  - message text is purged after 90 days;
  - closed tasks after 18 months;
  - a nightly job enforces both.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test          # vitest on an embedded Postgres (PGlite): no Postgres, IMAP, SMTP or API key needed
pnpm eval          # the extraction eval set, against the mock AI (pnpm eval --extractor claude costs money)
pnpm dev:api       # API with reload, http://localhost:3000
pnpm dev:web       # web app dev server on :5173 (proxies /api)
pnpm dev:worker
```

| Folder | What it holds |
|---|---|
| `src/mail` | MIME parsing, reply/quote segmentation, filters, conversations, IMAP sync |
| `src/ai` | the prompt, and the extractors: Claude, OpenAI and Grok, Gemini, and the mock |
| `src/engine` | context building, reconciliation, applying changes, the queue |
| `src/chat` | the optional chat: its prompt, the lookups over a user's own mail and tasks, the Gemini client |
| `src/digest` | the daily report |
| `src/server` | the API, sign-in, one-click pages |
| `web/` | the React web app |
| `src/worker` | the worker's wiring, scheduler and IMAP watchers |
| `src/cli` | the command-line tool |
| `src/ops` | health checks, alerts, retention, KPIs |

Migrations are committed SQL in `drizzle/`. Change `src/db/schema.ts`, then run `pnpm db:generate`, and never edit
a committed migration.

## License

[MIT](LICENSE)
