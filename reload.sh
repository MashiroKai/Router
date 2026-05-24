#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Router Hot Reload — send SIGHUP to running Router for zero-downtime restart
# ═══════════════════════════════════════════════════════════════════
#
# Usage: bash reload.sh
#
# The running Router process will:
#   1. Close its server socket (stop accepting new connections)
#   2. Spawn a new Router process (reads updated code + config)
#   3. Exit gracefully
#
# Downtime is typically < 100ms.

PID_FILE="$(cd "$(dirname "$0")" && pwd)/.pids"

if [ ! -f "$PID_FILE" ]; then
  echo "ERROR: No PID file found. Is Router running? (bash start.sh)"
  exit 1
fi

# Find the Router process (first PID in .pids, which is proxy-router.mjs)
ROUTER_PID=$(head -1 "$PID_FILE" 2>/dev/null)

if [ -z "$ROUTER_PID" ]; then
  echo "ERROR: PID file is empty. Is Router running?"
  exit 1
fi

if ! kill -0 "$ROUTER_PID" 2>/dev/null; then
  echo "ERROR: Router process $ROUTER_PID is not running."
  exit 1
fi

echo "Sending SIGHUP to Router (PID $ROUTER_PID)..."
kill -HUP "$ROUTER_PID"

sleep 4

# Verify new process is up
NEW_PID=$(lsof -ti :9997 2>/dev/null | head -1)
if [ -n "$NEW_PID" ]; then
  echo "SUCCESS: Router is running on port 9997 (new PID $NEW_PID)"
else
  echo "WARNING: Port 9997 not detected yet — check logs/router/server.log"
fi
