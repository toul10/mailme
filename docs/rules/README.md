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
  `ignore` rules dismiss tasks, the `answered` rule completes them.
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
| `forward` | `topics`, `target`, `except` | A new mail from an outside sender, with a subject about the topics and without `target` in To or Cc, becomes one task: forward it to `target`. That mail doesn't go to the AI. |
| `answered` | | When you or a colleague (someone from your company's mail domains) replies later in the conversation, the requests made to you there are completed and listed in the daily report under "Answered". |
| `updates` | `topics`, `except` | Your own new mail (not a reply or a forward) with a subject about the topics is listed in the daily report under "Updates". |
| `summary` | | The daily report opens with a summary of the day. |
| `note` | | Text for the AI only: judgement that code can't make, e.g. what counts as a service request at your company. |
| `spam` | | With `"enabled": false`, the spam and phishing filters let your mail through. Leave it on. |

`answered`, `updates` and `summary` work one rule each: the first enabled rule of that kind counts.
