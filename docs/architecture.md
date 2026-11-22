# How MailMe works

This is a map for contributors and for anyone who wants to know what happens to their mail. For installation, see
[INSTALL.md](INSTALL.md).

## The pipeline

```
IMAP (read-only) ─┐                                       ┌─ web app: tasks, the sender's own words, one-tap fixes
Ingest API ───────┼─► ingest → filters → conversations ─► queue ─► AI extraction ─► reconciler ─► PostgreSQL
Outlook agent ────┘        (rules, no AI)         (per mailbox, in order)     (who may change what) └─ daily report
```

1. **Ingest** (`src/mail`). A message arrives from one of three sources:
   - the IMAP sync;
   - the ingest API (`POST /api/ingest/:mailboxId` with a per-mailbox token);
   - `pnpm cli import:eml`.

   Each message is then:
   - parsed (MIME, charset repair, calendar invites, delivery reports, S/MIME and TNEF detection);
   - de-duplicated by Message-ID, or by a content hash when there is none;
   - split into segments: new text, quoted text, forwarded text and signatures. Greek and English reply headers,
     Outlook, Gmail, Apple Mail and Thunderbird formats are all recognised.
   - Card numbers, IBANs and passwords are masked in the stored text.
2. **Filters** (`src/mail/prefilter.ts`). No AI is involved; the filters recognise:
   - own mail and the platform's own reports;
   - drafts and deleted items;
   - bulk mail and newsletters, no-reply notifications, delivery failures;
   - out-of-office and auto-replies, calendar replies;
   - spam (including phishing that impersonates the owner or a well-known brand);
   - encrypted or empty mail, the deny-list, and the owner's own ignore rules.

   Filtered mail is stored as metadata only and never reaches the AI.
3. **Conversations** (`src/mail/thread.ts`). A message joins a conversation through, in order:
   - its References and In-Reply-To headers;
   - Outlook's Thread-Index;
   - as a last resort, the subject and participants within 30 days. Generic subjects such as "Re: Hello" are never
     linked this way.
4. **Queue** (`src/engine/pipeline.ts`).
   - Each mailbox is processed strictly in order of the message date. A message waits `SETTLE_SEC` (180 s by
     default) so that a late copy in Sent is seen first.
   - A mailbox's queue is drained under a database lock, so no mailbox is ever processed twice at the same time.
5. **Extraction** (`src/ai`). The AI gets the new text of the message, a short context and a strict JSON schema.
   - The context is the conversation, the related open tasks and the owner's notes and rules.
   - It answers with *operations*: create a task, update it, complete it, reopen it, or nothing. Every operation must
     quote the sentence it is based on.
   - The prompt is English with Greek and English examples. It treats mail text as data and never as instructions.
   - The provider is chosen in Admin → AI: Claude (`src/ai/claude.ts`), OpenAI or Grok (`src/ai/openai-compat.ts`),
     or Gemini (`src/ai/gemini.ts`). All of them run the same prompt. The worker follows the choice before each
     drain (`src/ai/resolve.ts`):
     - `AI_MODE=mock` is the kill switch: the worker calls no provider at all (a key pasted in Admin → AI is still
       checked against the provider's free model list);
     - with no AI chosen: Claude when `ANTHROPIC_API_KEY` is set, otherwise the mock;
     - a chosen provider without a usable key (or model) pauses AI until it is fixed, instead of falling back to the
       mock.
   - The mock (`src/ai/mock.ts`) is a deterministic heuristic extractor that makes no network calls.
6. **Reconciliation** (`src/engine/reconcile.ts`). Deterministic code decides what the AI's operations may do.
   - **Grounding.** The quoted evidence must actually be in the message. The due date is computed by code from the
     phrase ("by Friday", «μέχρι αύριο») and the business calendar, never by the AI.
   - **Authority.**
     - A customer's e-mail can propose closing your task, but not close it.
     - Fields you changed yourself are locked against the AI.
     - A request where you are only in Cc is not your task unless it names you.
   - **Tiers.** A confident change is applied. An unsure one becomes a *suggestion*, a plain question in the web
     app ("Done already?"). Anything else is only logged.
   - **Negative examples.** A task you marked "Not a task" teaches the reconciler not to create the same one again.
7. **Apply** (`src/engine/apply.ts`). The changes are applied in one transaction:
   - tasks, links to the messages, an event log of every operation (applied, suggested or logged);
   - the company, from the sender's domain;
   - follow-up dates, e.g. "waiting for a reply since…".
8. **Daily report** (`src/digest`). Every business day at the user's time (07:30 by default) MailMe builds the report
   and delivers it once, never twice:
   - **Sections:** due today, your promises, follow-ups, new tasks, auto-closed, "still valid?".
   - **Links:** each line has signed one-click links (done, snooze, open).
   - **Delivery:** the report is added to the inbox with IMAP APPEND, or sent with SMTP.

## The chat

"Ask your mail" (`src/chat`, `POST /api/chat`) is optional and off by default (`CHAT_MODE`). It is not part of the
pipeline: it only reads what the pipeline stored. [INSTALL.md](INSTALL.md#ask-your-mail) says what an operator
should know before turning it on.

1. **Question.** The question goes to the model with the earlier turns of the conversation and a JSON schema for
   the reply. The model is Gemini (`src/chat/gemini.ts`); the API reads its key from `CHAT_API_KEY`.
2. **Lookups.** The model replies with *lookups*: search the mail, read a conversation, search the task list.
   - Deterministic code runs them (`src/chat/search.ts`), each in a read-only transaction with a statement timeout,
     and only over the asking user's mailboxes and tasks.
   - What the chat must never read is left out there, in SQL and in code: spam and phishing, drafts and deleted
     mail, private folders, the deny-list, ignored senders, mail classified as personal and mail not analysed yet.
     Nothing depends on the model obeying an instruction.
3. **Answer.** After at most 4 rounds the model answers and names the handles of the messages and tasks it relied
   on. The server turns those handles into source cards (`src/chat/engine.ts`): a handle that no lookup of this
   conversation returned is dropped.
4. **Stream.** The reply reaches the browser as NDJSON: the steps in plain words, then the answer.
   - The conversation lives in the browser's memory only (`web/src/chat-store.ts`).
   - The server stores one `chat.ask` row per question in `security_audit`, with counts and cost; the daily limits
     count those rows (`src/chat/usage.ts`).

## Processes

| Process | Command | Holds |
|---|---|---|
| API + web app | `pnpm start:api` | the **public** sealing key only, so it can never open a mailbox password. An AI key only where the chat is on (`CHAT_MODE`, off by default) |
| Worker | `pnpm start:worker` | the **private** sealing key. One IMAP watcher per mailbox (IDLE on the inbox, polling other folders), the queue, report dispatch every minute, aging hourly, health checks every 5 minutes, retention nightly |
| Worker, one pass | `pnpm start:tick` | the worker's jobs once, then exit. For hosts that start the worker on a timer, such as the Cloud Run job in [deploy/gcp](../deploy/gcp/README.md) |
| CLI | `pnpm cli <command>` | the same keys as the worker |

- **One worker.** Only one worker runs per database. It holds a Postgres advisory lock. If the database ends that
  session (a restart, maintenance), the worker exits 1 and its supervisor starts it again: Docker, systemd, launchd
  or Cloud Run.
- **Shutdown.** On SIGTERM the worker finishes the message in flight (up to 110 s) and releases its locks.

## Data model

`src/db/schema.ts` is the source of truth; the migrations in `drizzle/` are generated from it and never edited.

| Table | What it holds |
|---|---|
| `organizations`, `users` | tenants: internal mail domains, timezone, holiday options; accounts: role, TOTP, report settings |
| `mailboxes`, `mailbox_folders`, `mailbox_login_attempts` | connection settings, the sealed password, sync state, folder roles and sync switches; every sign-in attempt (the ban budget) |
| `threads`, `messages`, `message_locations` | conversations; one row per message per mailbox: headers, segments, state, filter reason; where it was seen (folder, UID) |
| `extractions` | each AI call: model, usage, cost, the raw operations |
| `tasks`, `task_links`, `task_events` | tasks, the messages behind them, and an event for every change (who, what, applied or suggested) |
| `company_domains`, `message_labels` | which company a sender domain belongs to; blind labels for measuring precision (`pnpm cli audit:*`) |
| `digests`, `action_nonces` | one report per user and day (exactly-once delivery); single-use one-click link nonces |
| `sessions`, `trusted_devices`, `security_audit` | sign-in sessions (only a hash of the token is stored), remembered devices, an audit trail |
| `health_state`, `app_state` | alert de-duplication, the global AI pause switch |
| `ai_settings`, `ai_providers` | the installation's AI choice (provider, model, a version the worker follows) and the worker's last report; per provider: the sealed key and its last 4 characters, an environment key's last 4, the listed models |

## Security model

- **Mail credentials.**
  - The API seals each mailbox password with an X25519 public key (`src/lib/sealed.ts`) and never sees it again.
  - The private key is a file held only by the worker and the CLI. It is never in the database, in environment
    variables or in database backups.
  - If the API server is compromised, mailbox passwords are not exposed.
  - Where that holds: with Docker, only the worker container gets the private key; on Google Cloud, only the worker
    job's service account may read its secret. A plain Node.js install runs the API and the worker as the same OS
    user, so there only the code keeps the API away from the key file. To keep the separation there too, run the API
    as a different user that can't read `data/keys/credentials.key.pem`.
- **AI keys.**
  - The API uses a key pasted in Admin → AI only to list its models (which also proves it works). Then it seals it
    with the same public key as a mailbox password, and only the worker can open it.
  - No response, log line or audit entry carries a key or a provider's error text, only the key's last 4
    characters. Every change is written to `security_audit`.
  - Environment keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`) reach the worker only:
    Docker blanks them for the API and the migrations.
  - The chat is the one exception, and it is off by default. Where it is on, the API holds one AI key of its own,
    `CHAT_API_KEY`. It is read from the environment and never stored, and it is not one of the worker's keys.
    Docker blanks it for the worker and the migrations; on Google Cloud only the API's service account may read
    its secret. The keys of Admin → AI stay sealed for the worker.
- **Mail servers.**
  - Users can only point the web app at public mail servers. `src/server/host-policy.ts` blocks private, loopback,
    link-local and metadata addresses, as an SSRF guard.
  - The CLI is an operator tool and is not restricted.
- **Sign-in.**
  - argon2id password hashes and TOTP;
  - CSRF tokens on every state-changing request;
  - per-IP rate limits on sign-in, codes, probes, ingest and one-click links. `TRUST_PROXY` decides which proxy may
    set the client address.
- **One-click links.** Signed with `LINK_SECRET`, single use, valid up to 7 days. A GET only shows a confirmation;
  only the POST acts.
- **Logs.** Logs and alerts carry ids, counts, durations and error codes only. As a safety net, the logger also
  blanks fields that could hold mail content (`src/lib/log.ts`).
- **Prompt injection.**
  - Mail text goes to the AI as delimited data.
  - Whatever the AI answers, the reconciler's authority rules decide what may change. An e-mail that says "mark all
    tasks done" can at most produce a suggestion.
  - The eval set (`eval/cases`) includes adversarial cases and scores *unauthorized changes after reconciliation*.
  - The chat's model can only read. A mail that gives it orders can change what an answer says, not what MailMe
    does, and every answer names the messages it was taken from.

## Tests and evals

- `pnpm test`:
  - runs more than 2,000 tests on an embedded Postgres (PGlite), with no network;
  - fake IMAP, SMTP and AI clients cover the sync, delivery and extraction paths;
  - set `TEST_PG_URL` to run on a real Postgres.
- `pnpm eval`:
  - runs the synthetic extraction cases in `eval/cases` against the mock extractor;
  - scores detection, status, owner, due date, grounding and how often answers change between runs;
  - `pnpm eval --extractor claude --yes-spend` runs them against the real API and costs money. Extraction quality
    was measured this way, with Claude; the other providers run the same prompt.
