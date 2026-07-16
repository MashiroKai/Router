#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Nebflow LLM Log Reader — Launcher
# ═══════════════════════════════════════════════════════════════════

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
PID_FILE="$SCRIPT_DIR/.pids"

# Colors
R='\033[0;31m' G='\033[0;32m' Y='\033[0;33m' B='\033[0;34m' NC='\033[0m'

# Kill old processes
cleanup() {
  if [ -f "$PID_FILE" ]; then
    echo -e "${Y}Stopping old reader...${NC}"
    while read pid; do
      kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
    sleep 1
  fi
  for port in 9997; do
    lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null || true
  done
  sleep 1
}

trap cleanup EXIT INT TERM
cleanup

echo -e "${B}══════════════════════════════════════════════════════════════${NC}"
echo -e "${B}  Nebflow LLM Log Reader${NC}"
echo -e "${B}══════════════════════════════════════════════════════════════${NC}"
echo ""

# Check node
if ! command -v node &>/dev/null; then
  echo -e "${R}ERROR: node not found. Install Node.js first.${NC}"
  exit 1
fi

node "$SRC_DIR/server.mjs" &
echo $! >> "$PID_FILE"

echo -e "  ${G}Viewer${NC}    → http://127.0.0.1:9997/"
echo ""
echo -e "  Logs: ~/.nebflow/logs/router/"
echo -e "  Stop: ${Y}bash $SCRIPT_DIR/stop.sh${NC}"
echo ""

# Keep running in foreground (Ctrl+C to stop)
wait
