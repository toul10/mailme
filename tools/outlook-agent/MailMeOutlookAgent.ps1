<#
.SYNOPSIS
    MailMe Outlook agent: uploads new mail from Outlook folders (default: Sent Items) to the MailMe ingest API.

.DESCRIPTION
    *** UNTESTED - written without a Windows PC with Outlook to test on. Test it first (tools/outlook-agent/README.md). ***

    Backup ingest path for users whose sent copies never reach the mail server (e.g. Outlook on POP3).
    Runs as a Scheduled Task every 10 minutes in the user's own session:
      - reads the configured Outlook folders through Outlook's COM object model (Outlook must be installed and
        the profile configured; it does not need to be open);
      - picks items newer than the last successful run (Items.Restrict + an exact re-check);
      - rebuilds a minimal RFC 5322 message per MailItem: headers (Message-ID, In-Reply-To, References,
        Thread-Index, From/To/Cc, Subject, Date) + text/plain + text/html. Attachment *names* go into the
        X-MailMe-Attachments header; attachment contents are never uploaded;
      - POSTs it to <apiBase>/api/ingest/<mailboxId> with the bearer token; Sent-folder items carry
        "x-mailme-declared-outbound: 1" (the server still requires From = the mailbox owner);
      - remembers the newest uploaded timestamp per folder in the state file. A failed upload stops that folder
        and is retried next run (no loss, only delay); the server de-duplicates by Message-ID.
    Logs contain counts and error codes only - never subjects, addresses or folder names.

    PowerShell 5.1 compatible (Windows 10/11 default). This file is pure ASCII on purpose: PowerShell 5.1 reads
    scripts without a BOM in the ANSI code page.

.PARAMETER ConfigPath
    JSON config (see config.example.json). Default: mailme-agent.json next to this script.

.PARAMETER DryRun
    Build the messages and report counts, upload nothing, keep the state unchanged.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\MailMe\MailMeOutlookAgent.ps1 -DryRun -Verbose
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'mailme-agent.json'),
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# -- MAPI property tags ------------------------------------------------------------------------------------
$PR_TRANSPORT_MESSAGE_HEADERS = 'http://schemas.microsoft.com/mapi/proptag/0x007D001F'
$PR_INTERNET_MESSAGE_ID       = 'http://schemas.microsoft.com/mapi/proptag/0x1035001F'
$PR_IN_REPLY_TO_ID            = 'http://schemas.microsoft.com/mapi/proptag/0x1042001F'
$PR_INTERNET_REFERENCES       = 'http://schemas.microsoft.com/mapi/proptag/0x1039001F'
$PR_SMTP_ADDRESS              = 'http://schemas.microsoft.com/mapi/proptag/0x39FE001E'
$olMail = 43
$olFolderInbox = 6
$olFolderSentMail = 5
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Invariant = [Globalization.CultureInfo]::InvariantCulture

# -- Config & state ----------------------------------------------------------------------------------------
function Read-JsonFile([string]$Path) {
    return [IO.File]::ReadAllText($Path, $Utf8) | ConvertFrom-Json
}

function Get-Setting($Object, [string]$Name, $Default) {
    if ($Object.PSObject.Properties.Name -contains $Name -and $null -ne $Object.$Name -and "$($Object.$Name)" -ne '') { return $Object.$Name }
    return $Default
}

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Config file not found: $ConfigPath" }
$config = Read-JsonFile $ConfigPath
$apiBase = ([string](Get-Setting $config 'apiBase' '')).TrimEnd('/')
$mailboxId = [string](Get-Setting $config 'mailboxId' '')
$token = [string](Get-Setting $config 'token' '')
if (-not $apiBase -or -not $mailboxId -or -not $token) { throw 'Config needs apiBase, mailboxId and token' }
if ($apiBase -notmatch '^https://' -and $apiBase -notmatch '^http://(localhost|127\.0\.0\.1)') { throw 'apiBase must be https:// (plain http only for localhost)' }
$folders = @(Get-Setting $config 'folders' @('Sent Items'))
$outboundFolders = @(Get-Setting $config 'outboundFolders' @('Sent Items'))
$stateFile = [string](Get-Setting $config 'stateFile' (Join-Path $PSScriptRoot 'mailme-agent.state.json'))
$logFile = [string](Get-Setting $config 'logFile' (Join-Path $PSScriptRoot 'mailme-agent.log'))
$lookbackDays = [int](Get-Setting $config 'firstRunLookbackDays' 3)
$maxItems = [int](Get-Setting $config 'maxItemsPerRun' 300)
$maxBytes = [int](Get-Setting $config 'maxMessageBytes' (9 * 1024 * 1024))

function Write-Log([string]$Message) {
    $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK', $Invariant), $Message
    try { [IO.File]::AppendAllText($logFile, $line + "`r`n", $Utf8) } catch { }
    Write-Verbose $line
}

function Read-State {
    $state = @{}
    if (Test-Path -LiteralPath $stateFile) {
        $raw = Read-JsonFile $stateFile
        if ($raw.PSObject.Properties.Name -contains 'folders') {
            foreach ($p in $raw.folders.PSObject.Properties) { $state[$p.Name] = [string]$p.Value }
        }
    }
    return $state
}

function Save-State([hashtable]$State) {
    $obj = New-Object PSObject -Property @{ folders = (New-Object PSObject -Property $State); updated = (Get-Date).ToUniversalTime().ToString('o') }
    $tmp = "$stateFile.tmp"
    [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 4), $Utf8)
    Move-Item -LiteralPath $tmp -Destination $stateFile -Force
}

# Folder labels in the log are a short hash, never the name (folder names can be customer names).
function Get-FolderTag([string]$Name) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash($Utf8.GetBytes($Name))
    return ([BitConverter]::ToString($hash, 0, 4) -replace '-', '').ToLowerInvariant()
}

# -- MIME helpers ------------------------------------------------------------------------------------------
function Encode-Word([string]$Text) {
    if ($null -eq $Text) { return '' }
    $clean = $Text -replace "[`r`n]+", ' '
    if ($clean -match '^[\x20-\x7E]*$') { return $clean }
    return '=?UTF-8?B?' + [Convert]::ToBase64String($Utf8.GetBytes($clean)) + '?='
}

function Format-Address([string]$Name, [string]$Address) {
    if (-not $Address) { return $null }
    if ($Name -and $Name -ne $Address) {
        $n = Encode-Word $Name
        if ($n -notmatch '^=\?') { $n = '"' + ($n -replace '"', "'") + '"' }
        return "$n <$Address>"
    }
    return "<$Address>"
}

function Format-RfcDate([datetime]$Date) {
    $offset = [TimeZoneInfo]::Local.GetUtcOffset($Date)
    $sign = '+'
    if ($offset.Ticks -lt 0) { $sign = '-' }
    $abs = $offset.Duration()
    return $Date.ToString('ddd, dd MMM yyyy HH:mm:ss', $Invariant) + (' {0}{1:00}{2:00}' -f $sign, $abs.Hours, $abs.Minutes)
}

function Get-Prop($Item, [string]$Tag) {
    try { return [string]$Item.PropertyAccessor.GetProperty($Tag) } catch { return '' }
}

function Get-SmtpAddress($AddressEntry, [string]$Fallback) {
    try {
        if ($null -ne $AddressEntry -and $AddressEntry.Type -eq 'EX') {
            $user = $AddressEntry.GetExchangeUser()
            if ($null -ne $user -and $user.PrimarySmtpAddress) { return [string]$user.PrimarySmtpAddress }
            $smtp = [string]$AddressEntry.PropertyAccessor.GetProperty($PR_SMTP_ADDRESS)
            if ($smtp) { return $smtp }
        }
    } catch { }
    return $Fallback
}

function Get-Base64Lines([byte[]]$Bytes) {
    $b64 = [Convert]::ToBase64String($Bytes)
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $b64.Length; $i += 76) {
        [void]$sb.Append($b64.Substring($i, [Math]::Min(76, $b64.Length - $i))).Append("`r`n")
    }
    return $sb.ToString()
}

# Received items keep their original transport headers (delivery trace, list headers); the MIME structure
# headers are dropped because the body is rebuilt below. Sent items have none, so headers are rebuilt.
function Get-TransportHeaderBlock($Item) {
    $raw = Get-Prop $Item $PR_TRANSPORT_MESSAGE_HEADERS
    if (-not $raw) { return $null }
    $unfolded = ($raw -replace "`r?`n[ `t]+", ' ') -split "`r?`n"
    $keep = New-Object System.Collections.Generic.List[string]
    foreach ($line in $unfolded) {
        if (-not $line) { continue }
        if ($line -match '^(Content-[A-Za-z-]+|MIME-Version):') { continue }
        $keep.Add($line)
    }
    return ($keep -join "`r`n")
}

function Build-Mime($Item) {
    $headers = New-Object System.Collections.Generic.List[string]
    $transport = Get-TransportHeaderBlock $Item
    if ($transport) {
        $headers.Add($transport)
    } else {
        $fromAddr = Get-SmtpAddress $Item.Sender ([string]$Item.SenderEmailAddress)
        $from = Format-Address ([string]$Item.SenderName) $fromAddr
        if ($from) { $headers.Add("From: $from") }
        $to = @(); $cc = @(); $bcc = @()
        foreach ($r in @($Item.Recipients)) {
            $addr = Get-SmtpAddress $r.AddressEntry ([string]$r.Address)
            $formatted = Format-Address ([string]$r.Name) $addr
            if (-not $formatted) { continue }
            switch ([int]$r.Type) { 1 { $to += $formatted } 2 { $cc += $formatted } 3 { $bcc += $formatted } }
        }
        if ($to.Count) { $headers.Add('To: ' + ($to -join ', ')) }
        if ($cc.Count) { $headers.Add('Cc: ' + ($cc -join ', ')) }
        if ($bcc.Count) { $headers.Add('Bcc: ' + ($bcc -join ', ')) }
        $headers.Add('Subject: ' + (Encode-Word ([string]$Item.Subject)))
        $when = $Item.SentOn
        if ($null -eq $when -or $when.Year -lt 1990) { $when = $Item.ReceivedTime }
        $headers.Add('Date: ' + (Format-RfcDate $when))
        $msgId = Get-Prop $Item $PR_INTERNET_MESSAGE_ID
        if ($msgId) { $headers.Add("Message-ID: $msgId") }
        $inReplyTo = Get-Prop $Item $PR_IN_REPLY_TO_ID
        if ($inReplyTo) { $headers.Add("In-Reply-To: $inReplyTo") }
        $refs = Get-Prop $Item $PR_INTERNET_REFERENCES
        if ($refs) { $headers.Add("References: $refs") }
        try {
            $ci = [string]$Item.ConversationIndex
            if ($ci -and $ci.Length % 2 -eq 0) {
                $bytes = New-Object byte[] ($ci.Length / 2)
                for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($ci.Substring($i * 2, 2), 16) }
                $headers.Add('Thread-Index: ' + [Convert]::ToBase64String($bytes))
            }
        } catch { }
    }
    $names = @()
    foreach ($a in @($Item.Attachments)) { if ($a.FileName) { $names += [string]$a.FileName } }
    if ($names.Count) { $headers.Add('X-MailMe-Attachments: ' + (Encode-Word ($names -join '; '))) }
    $headers.Add('X-MailMe-Source: outlook-agent')
    $headers.Add('MIME-Version: 1.0')

    $boundary = '=_mailme_' + [Guid]::NewGuid().ToString('N')
    $headers.Add("Content-Type: multipart/alternative; boundary=`"$boundary`"")
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append(($headers -join "`r`n")).Append("`r`n`r`n")
    $plain = [string]$Item.Body
    $html = ''
    try { $html = [string]$Item.HTMLBody } catch { }
    [void]$sb.Append("--$boundary`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Transfer-Encoding: base64`r`n`r`n")
    [void]$sb.Append((Get-Base64Lines $Utf8.GetBytes($plain)))
    if ($html) {
        [void]$sb.Append("--$boundary`r`nContent-Type: text/html; charset=utf-8`r`nContent-Transfer-Encoding: base64`r`n`r`n")
        [void]$sb.Append((Get-Base64Lines $Utf8.GetBytes($html)))
    }
    [void]$sb.Append("--$boundary--`r`n")
    return ,$Utf8.GetBytes($sb.ToString())
}

# -- Outlook -----------------------------------------------------------------------------------------------
function Resolve-Folder($Namespace, [string]$Spec) {
    # Default folders resolve in any Outlook UI language.
    if ($Spec -eq 'Sent Items' -or $Spec -eq 'Sent') { return $Namespace.GetDefaultFolder($olFolderSentMail) }
    if ($Spec -eq 'Inbox') { return $Namespace.GetDefaultFolder($olFolderInbox) }
    # Full path, e.g. "\\owner@contoso.example\Sent Items" (IMAP accounts have their own store).
    $parts = @($Spec.TrimStart('\') -split '\\' | Where-Object { $_ })
    if ($parts.Count -lt 2) { throw "Folder '$Spec' not found (use 'Sent Items', 'Inbox' or a full path like \\store\folder)" }
    $current = $Namespace.Folders.Item($parts[0])
    for ($i = 1; $i -lt $parts.Count; $i++) { $current = $current.Folders.Item($parts[$i]) }
    return $current
}

function Get-ItemTime($Item, [bool]$Outbound) {
    if ($Outbound) { return $Item.SentOn }
    return $Item.ReceivedTime
}

function Send-Message([byte[]]$Bytes, [bool]$Outbound) {
    $headers = @{ Authorization = "Bearer $token" }
    if ($Outbound) { $headers['x-mailme-declared-outbound'] = '1' }
    $resp = Invoke-WebRequest -Method Post -Uri "$apiBase/api/ingest/$mailboxId" -Headers $headers -ContentType 'message/rfc822' -Body $Bytes -UseBasicParsing -TimeoutSec 60
    return [int]$resp.StatusCode
}

# -- Main --------------------------------------------------------------------------------------------------
$state = Read-State
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace('MAPI')
$totals = @{ uploaded = 0; skipped = 0; failed = 0 }

foreach ($spec in $folders) {
    $key = [string]$spec
    $tag = Get-FolderTag $key
    $outbound = [bool]($outboundFolders -contains $spec)
    try {
        $folder = Resolve-Folder $ns $key
    } catch {
        Write-Log ("folder_error folder={0} code={1}" -f $tag, $_.Exception.GetType().Name)
        $totals.failed++
        continue
    }
    $since = (Get-Date).AddDays(-$lookbackDays)
    if ($state.ContainsKey($key)) { $since = [datetime]::Parse($state[$key], $Invariant, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime() }
    # Restrict needs the local short date/time format (no seconds): ask for a minute earlier, re-check exactly below.
    $field = '[ReceivedTime]'
    if ($outbound) { $field = '[SentOn]' }
    $items = $folder.Items
    $candidates = $items
    try { $candidates = $items.Restrict("$field >= '" + $since.AddMinutes(-1).ToString('g') + "'") } catch { $candidates = $items }

    $batch = New-Object System.Collections.Generic.List[object]
    foreach ($it in $candidates) {
        if ($it.Class -ne $olMail) { continue }
        $t = Get-ItemTime $it $outbound
        # -lt: the item at the saved timestamp is sent again (the server de-duplicates), so equal timestamps are never lost.
        if ($null -eq $t -or $t -lt $since) { continue }
        $batch.Add($it)
    }
    $sorted = @($batch | Sort-Object { Get-ItemTime $_ $outbound })
    if ($sorted.Count -gt $maxItems) { $sorted = $sorted[0..($maxItems - 1)] }

    $uploaded = 0
    foreach ($it in $sorted) {
        $t = Get-ItemTime $it $outbound
        try {
            $bytes = Build-Mime $it
            if ($bytes.Length -gt $maxBytes) {
                $totals.skipped++
                Write-Log ("skip_too_large folder={0} bytes={1}" -f $tag, $bytes.Length)
            } elseif (-not $DryRun) {
                [void](Send-Message $bytes $outbound)
                $uploaded++
            } else {
                $uploaded++
            }
            if (-not $DryRun) {
                $state[$key] = $t.ToUniversalTime().ToString('o')
                Save-State $state
            }
        } catch {
            $status = ''
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
            Write-Log ("upload_failed folder={0} status={1} code={2}" -f $tag, $status, $_.Exception.GetType().Name)
            $totals.failed++
            break   # keep the order: retry from this item on the next run
        }
    }
    $totals.uploaded += $uploaded
    Write-Log ("folder_done folder={0} outbound={1} items={2} uploaded={3} dryRun={4}" -f $tag, $outbound, $sorted.Count, $uploaded, [bool]$DryRun)
}

Write-Log ("run_done uploaded={0} skipped={1} failed={2}" -f $totals.uploaded, $totals.skipped, $totals.failed)
if ($totals.failed -gt 0) { exit 1 }
exit 0
