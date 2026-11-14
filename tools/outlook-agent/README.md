# MailMe Outlook agent (backup ingest path)

> **Status: UNTESTED.** It was written without a Windows PC with Outlook to test on. Run the dry run and the checks
> below on the user's PC before relying on it. Reports and fixes are welcome.

MailMe learns what you promised from your sent mail. Use the agent only if a user's **sent** mail never reaches the
mail server (e.g. Outlook on POP3 and the account can't move to IMAP). The agent reads Outlook's *Sent Items* through Outlook's COM interface and uploads
each new message to the MailMe ingest API. It catches up whenever it runs, so an off PC delays mail but loses none.

What is uploaded: a rebuilt RFC 5322 message with the headers (Message-ID, In-Reply-To, References, Thread-Index,
From/To/Cc, Subject, Date), the text and HTML bodies, and the attachment **names** (`X-MailMe-Attachments`).
Attachment contents are never uploaded. The agent's log holds counts and error codes only.

## Install (on the user's PC, as the Outlook user)

1. Issue a token for the mailbox (on the MailMe host):
   ```sh
   pnpm cli mailbox:ingest-token --mailbox <mailbox id or address>
   ```
   The same mailbox can also be synced over IMAP: the server de-duplicates by Message-ID.
2. Copy `MailMeOutlookAgent.ps1` and `config.example.json` to `C:\MailMe\`. Rename the config to
   `mailme-agent.json` and fill in `apiBase` (https only), `mailboxId` and `token`. Restrict the folder to the user:
   ```powershell
   icacls C:\MailMe /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"
   ```
3. Dry run (builds messages, uploads nothing, state unchanged):
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\MailMe\MailMeOutlookAgent.ps1 -DryRun -Verbose
   ```
4. Real run once, then check on the host that messages arrived (`pnpm cli kpi` → "Messages by state").
5. Scheduled Task every 10 minutes, **only when the user is logged on** (Outlook COM needs the user's session):
   ```powershell
   $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\MailMe\MailMeOutlookAgent.ps1'
   $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)
   $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 9)
   Register-ScheduledTask -TaskName 'MailMe Outlook Agent' -Action $action -Trigger $trigger -Settings $settings -Description 'Uploads new Sent Items to MailMe'
   ```
   Or with `schtasks`:
   ```bat
   schtasks /Create /TN "MailMe Outlook Agent" /SC MINUTE /MO 10 /IT /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\MailMe\MailMeOutlookAgent.ps1"
   ```

## Config (`mailme-agent.json`)

| Key | Default | Meaning |
|---|---|---|
| `apiBase` | — | `https://mailme.example.com` |
| `mailboxId` | — | Mailbox id in MailMe |
| `token` | — | Bearer token from `mailbox:ingest-token` |
| `folders` | `["Sent Items"]` | `Sent Items`, `Inbox` (default folders, any UI language) or a full path `\\store\folder` |
| `outboundFolders` | `["Sent Items"]` | Folders uploaded with `x-mailme-declared-outbound: 1` |
| `stateFile` | next to the script | Last uploaded timestamp per folder |
| `logFile` | next to the script | Counts / error codes only |
| `firstRunLookbackDays` | 3 | History uploaded on the first run |
| `maxItemsPerRun` | 300 | Oldest first; the rest follows on the next run |
| `maxMessageBytes` | 9 MiB | Larger rebuilt messages are skipped (the API accepts ≤ 10 MB) |

## Checks on the user's PC (before trusting it)

- [ ] PowerShell 5.1 (`$PSVersionTable`), Outlook desktop (classic) with the user's profile.
- [ ] **Object Model Guard:** with an outdated antivirus, Outlook asks "A program is trying to access e-mail address
      information". Fix the antivirus status; never click "Allow" as a workaround.
- [ ] `Items.Restrict` works with the PC's date format (the script re-checks each item's time anyway, and falls back to
      scanning the folder if Restrict fails).
- [ ] A sent Greek message arrives with the right Subject/From/To and its Message-ID (thread linking depends on it).
- [ ] A message with an attachment shows the attachment name in MailMe's task evidence.
- [ ] Stopping the PC for a day, then starting it: the backlog uploads, in order, with no duplicates.
- [ ] The log contains no subjects, addresses or folder names.

## Uninstall

`Unregister-ScheduledTask -TaskName 'MailMe Outlook Agent'`, delete `C:\MailMe`, and rotate the token on the host
(`pnpm cli mailbox:ingest-token --mailbox … --yes`) so the old one stops working.
