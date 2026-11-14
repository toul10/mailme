#!/usr/bin/env bash
# MailMe on the Mac under launchd: the worker and the API start at login and are started again after a crash
# (KeepAlive on a non-zero exit — e.g. the worker exits 1 when Postgres restarts and its lock session is gone).
#
#   deploy/mac/launchd.sh install     write ~/Library/LaunchAgents/local.mailme.{worker,api}.plist, start both
#   deploy/mac/launchd.sh uninstall   stop both (SIGTERM, graceful) and remove the plists
#   deploy/mac/launchd.sh status      what launchd knows about them
#
# Logs append to data/worker-live.log and data/api-live.log.
# Moving to another host (Docker, deploy/gcp): run `uninstall` first. Never two workers on one database.
#
# macOS privacy (TCC) can keep launchd out of a repo under ~/Desktop, ~/Documents or ~/Downloads: the agent then exits
# 78 (EX_CONFIG) before node starts, with nothing in the logs. `install`
# detects that, removes the agents again and says what to do: give node Full Disk Access, or move the repo.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
NODE="$(command -v node || true)"
SERVICES=(worker api)

label() { echo "local.mailme.$1"; }
plist() { echo "$AGENTS/$(label "$1").plist"; }
entry() { case "$1" in worker) echo "src/worker/main.ts" ;; api) echo "src/server/main.ts" ;; esac; }
# Seconds launchd waits after SIGTERM before SIGKILL: the worker finishes the message in flight (≤ 110 s).
exit_timeout() { case "$1" in worker) echo 120 ;; api) echo 35 ;; esac; }
loaded() { launchctl print "$DOMAIN/$(label "$1")" >/dev/null 2>&1; }
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

# A process running this entry point that launchd did not start (nohup, a terminal): it must stop first.
stray_pids() {
  local svc="$1" managed=""
  if loaded "$svc"; then managed="$(launchctl print "$DOMAIN/$(label "$svc")" | awk '/^\tpid = /{print $3}')"; fi
  { pgrep -f "$(entry "$svc")" || true; } | while read -r pid; do
    [ "$pid" = "$managed" ] && continue
    # tsx's own parent/child processes for the same entry point count too; report every one.
    echo "$pid"
  done
}

write_plist() {
  local svc="$1"
  mkdir -p "$AGENTS"
  cat >"$(plist "$svc")" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(label "$svc")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>--import</string>
    <string>tsx</string>
    <string>$(entry "$svc")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$(dirname "$NODE")"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>$(exit_timeout "$svc")</integer>
  <key>StandardOutPath</key><string>$(xml "$REPO/data/$svc-live.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$REPO/data/$svc-live.log")</string>
</dict>
</plist>
EOF
  plutil -lint "$(plist "$svc")" >/dev/null
}

case "${1:-}" in
  install)
    [ -n "$NODE" ] || { echo "node not found in PATH" >&2; exit 1; }
    [ -f "$REPO/.env" ] || { echo "$REPO/.env is missing" >&2; exit 1; }
    for svc in "${SERVICES[@]}"; do
      pids="$(stray_pids "$svc" | tr '\n' ' ')"
      if [ -n "${pids// /}" ]; then
        echo "$svc is already running outside launchd (pid $pids). Stop it first, e.g. kill -TERM <pid of node … $(entry "$svc")>," >&2
        echo "and wait for its log to say it stopped." >&2
        exit 1
      fi
    done
    for svc in "${SERVICES[@]}"; do
      if loaded "$svc"; then launchctl bootout "$DOMAIN/$(label "$svc")"; fi
      write_plist "$svc"
      launchctl bootstrap "$DOMAIN" "$(plist "$svc")"
      echo "started $(label "$svc") → data/$svc-live.log"
    done
    sleep 5
    for svc in "${SERVICES[@]}"; do
      if launchctl print "$DOMAIN/$(label "$svc")" 2>/dev/null | grep -q "last exit code = 78"; then
        for s2 in "${SERVICES[@]}"; do
          if loaded "$s2"; then launchctl bootout "$DOMAIN/$(label "$s2")" || true; fi
          rm -f "$(plist "$s2")"
        done
        echo "launchd could not start MailMe (exit 78, EX_CONFIG), most likely macOS privacy (TCC) keeping it out of $REPO." >&2
        echo "Either give $(realpath "$NODE") Full Disk Access (System Settings → Privacy & Security), or move" >&2
        echo "the repo out of ~/Desktop, ~/Documents and ~/Downloads; then run install again. The agents were removed." >&2
        exit 1
      fi
    done
    ;;
  uninstall)
    for svc in "${SERVICES[@]}"; do
      if loaded "$svc"; then
        launchctl bootout "$DOMAIN/$(label "$svc")" # SIGTERM, then SIGKILL after ExitTimeOut
        echo "stopped $(label "$svc")"
      fi
      rm -f "$(plist "$svc")"
    done
    for svc in "${SERVICES[@]}"; do
      if [ -n "$(stray_pids "$svc")" ]; then echo "WARNING: $svc is still running outside launchd: pid $(stray_pids "$svc" | tr '\n' ' ')" >&2; fi
    done
    ;;
  status)
    for svc in "${SERVICES[@]}"; do
      if loaded "$svc"; then
        launchctl print "$DOMAIN/$(label "$svc")" | awk -v l="$(label "$svc")" '/^\tstate = |^\tpid = |^\tlast exit code = |^\truns = /{sub(/^\t/, ""); print l ": " $0}'
      else
        echo "$(label "$svc"): not loaded"
      fi
    done
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
