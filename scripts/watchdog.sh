#!/bin/bash
# merge-gateway-shim watchdog — runs every minute via launchd.
# Restores the shim and its Cloudflare tunnel after port theft, crashes,
# machine sleep, or tunnel death. Logs to /tmp/shim-watchdog.log.

HEALTH="http://127.0.0.1:8787/health"
LOG=/tmp/shim-watchdog.log
LABEL="com.vforcepros.merge-gateway-shim"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_N=$(id -u)
TS() { date "+%Y-%m-%d %H:%M:%S"; }

# --- 1. Is the shim healthy? --------------------------------------------
HEALTH_BODY=$(curl -s --max-time 3 "$HEALTH" 2>/dev/null)
if echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
  exit 0
fi
echo "$(TS) shim unhealthy (got: $(echo "$HEALTH_BODY" | head -c 60))" >> "$LOG"

# --- 2. Kill anything on 8787 that is NOT the shim -----------------------
# Match by command line: the shim is `node .../dist/index.js`. Everything
# else listening on the port is a squatter.
for PID in $(lsof -ti tcp:8787 -sTCP:LISTEN 2>/dev/null); do
  CMD=$(ps -p "$PID" -o command= 2>/dev/null)
  if echo "$CMD" | grep -q 'dist/index.js'; then
    continue  # our shim; leave it alone
  fi
  echo "$(TS) killing port squatter PID $PID ($(ps -p "$PID" -o comm= 2>/dev/null))" >> "$LOG"
  kill -9 "$PID" 2>/dev/null
done
sleep 1

# --- 3. Ensure the service is registered, then (re)start it ---------------
if ! launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
  echo "$(TS) service not registered; loading $PLIST" >> "$LOG"
  launchctl load "$PLIST" >> "$LOG" 2>&1
  sleep 2
fi
launchctl kickstart -k "gui/$UID_N/$LABEL" 2>>"$LOG"
sleep 3

# --- 4. Tunnel: restart the named tunnel if it is gone --------------------
if ! pgrep -f 'cloudflared tunnel --config.*merge-gateway-shim.yml' >/dev/null 2>&1; then
  echo "$(TS) named tunnel process gone; restarting" >> "$LOG"
  launchctl kickstart -k "gui/$UID_N/com.vforcepros.merge-gateway-tunnel" 2>>"$LOG"
  sleep 8
  echo "$(TS) named tunnel restarted (hostname unchanged: shim URL is permanent)" >> "$LOG"
fi

# --- 5. Final verification -------------------------------------------------
if curl -s --max-time 3 "$HEALTH" 2>/dev/null | grep -q '"status":"ok"'; then
  echo "$(TS) restored: shim healthy" >> "$LOG"
else
  echo "$(TS) FAILED to restore shim — needs manual attention" >> "$LOG"
fi
