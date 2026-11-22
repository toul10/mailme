# Mail rules

Rules are your own standing instructions, such as "mail about orders that has orders@ in Cc: ignore it, the orders
team has it". Each user has their own list. The filters, the AI, the daily report and the web app all read the same
list, so a new rule of a known kind needs no code.

An empty list changes nothing: each behaviour below is switched on by one rule.

## Import, check, apply

```sh
pnpm cli rules:import --user you@example.com --file my-rules.json   # replaces your whole list
pnpm cli rules:list   --user you@example.com
pnpm cli rules:apply  --user you@example.com                        # dry run: what would change in your open tasks
pnpm cli rules:apply  --user you@example.com --yes                  # do it
```

- `rules:import` refuses the whole file if one rule is unusable, and says which one and why.
- New rules apply to mail that arrives after the import. `rules:apply` applies them to the tasks you already have:
  `ignore` rules dismiss tasks, and the `answered` and `forward` rules complete them or hand them over (see
  [Replies and forwards](#replies-and-forwards)).
- In the web app, **What matters to me → Rules** lists your rules and switches each one on or off.

With Docker, copy the file into the worker and run the command there:

```sh
docker compose cp my-rules.json worker:/app/data/rules.json
docker compose exec worker node_modules/.bin/tsx src/cli/main.ts rules:import --user you@example.com --file /app/data/rules.json
```

## The file

A JSON object with a `rules` list (a bare list works too). [example.json](example.json) is a complete example for a
fictional company.

```json
{
  "rules": [
    {
      "id": "orders-cc",
      "kind": "ignore",
      "enabled": true,
      "text": "Mail about an order with orders@ in To or Cc: ignore it, the orders team has it.",
      "topics": ["order", "purchase order"],
      "recipients": ["orders@example.com"]
    }
  ]
}
```

| Field | What it holds |
|---|---|
| `id` | Lower-case letters, digits and dashes, unique in your list |
| `kind` | One of the kinds below |
| `enabled` | `false` keeps the rule but switches it off. Default `true` |
| `text` | The rule in your own words, up to 600 characters. Shown in the web app and given to the AI |
| `topics` | Keywords, matched at the start of a word and ignoring case and accents: `order` matches "Orders" and "ordered" |
| `except` | Phrases that switch the rule off for one mail, e.g. `"order has shipped"` |
| `recipients` | E-mail addresses or `@domain` entries |
| `target` | `forward` only: the address the mail should have gone to |

Limits: 50 rules; per rule, 60 topics and 30 recipients.

## Kinds

| Kind | Fields | What it does |
|---|---|---|
| `ignore` | `topics` and/or `recipients`, `except` | Mail about the topics, with one of the recipients in To or Cc, creates no task. Without topics, any mail with one of the recipients; without recipients, any mail about the topics. It applies to mail you receive and to mail you send. |
| `forward` | `topics`, `target`, `except` | A new mail from an outside sender, with a subject about the topics and without `target` in To or Cc, becomes one task: forward it to `target`. That mail doesn't go to the AI. The task is completed once a later mail from your company in the same conversation has `target` in To or Cc, or comes from `target`. |
| `answered` | | When you or a colleague (someone from your company's mail domains) replies later in the conversation, the requests made to you there are completed and listed in the daily report under "Answered". A request you forward to a colleague becomes the colleague's task and stays open until someone at your company replies to the person who asked. |
| `updates` | `topics`, `except` | Your own new mail (not a reply or a forward) with a subject about the topics is listed in the daily report under "Updates". |
| `summary` | | The daily report opens with a summary of the day. |
| `note` | | Text for the AI only: judgement that code can't make, e.g. what counts as a service request at your company. |
| `spam` | | With `"enabled": false`, the spam and phishing filters let your mail through. Leave it on. |

`answered`, `updates` and `summary` work one rule each: the first enabled rule of that kind counts.

## Replies and forwards

MailMe sees your own replies and forwards when a copy reaches the mailbox it reads: your Sent folder is synced, or
your mail program puts your own address in Cc. From that mail it keeps your tasks up to date without asking the AI.

A mail counts when all of these hold:

- it comes from you or from a colleague (your company's mail domains), and the mail server did not flag the sender
  as forged;
- it came after the mail that made the task, in the same conversation. In a conversation that was joined by its
  subject alone, it must also name that mail in its In-Reply-To or References header;
- it reached the AI's queue, or only one of your own `ignore` rules set it aside. Out-of-office replies, bulk mail
  and spam never count.

What happens then:

- **A reply** (with the `answered` rule) completes the requests made to you in that conversation. A forward is not
  a reply, and neither is the requester writing again.
- **A task of the `forward` rule** is completed once such a mail has `target` in To or Cc, or comes from `target`.
  This needs no `answered` rule, and it still works for old tasks after you switch the `forward` rule off.
- **A hand-over** (with the `answered` rule): you forward the request (FW:, or the Greek ΠΡ:) and every To recipient
  is a colleague. The task stays open and becomes the first To recipient's. It moves to the **Colleagues** tab as
  "Handled by …", and the next daily report says so once under "Forwarded to a colleague". From then on only a
  reply to the requester's side completes it: to the sender of the request, its Reply-To, the task's contact, or
  someone else at their company's domain. The colleague's "ok" to you does not.
- A forward that the AI still has to read is left alone until the AI has read it. One the AI acted on itself (a new
  task for the colleague, or a question on your task) is left to the AI.

A task you reopened after MailMe completed it, and a task whose status or owner you set by hand, stays as you left
it. There is no button yet to take a handed-over task back; you can still complete or remove it.
