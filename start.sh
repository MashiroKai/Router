#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Router Unified API Gateway — Launcher
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
    echo -e "${Y}Stopping old Router...${NC}"
    while read pid; do
      kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
    sleep 1
  fi
  # Also kill by port
  for port in 9997; do
    lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null || true
  done
  sleep 1
}

trap cleanup EXIT INT TERM
cleanup

echo -e "${B}══════════════════════════════════════════════════════════════${NC}"
echo -e "${B}  Router Unified AI Gateway${NC}"
echo -e "${B}══════════════════════════════════════════════════════════════${NC}"
echo ""

# Check node
if ! command -v node &>/dev/null; then
  echo -e "${R}ERROR: node not found. Install Node.js first.${NC}"
  exit 1
fi

# Validate API keys are set
MISSING=0
if [ -z "$ZHIPU_API_KEY" ]; then
  echo -e "${Y}WARNING: ZHIPU_API_KEY not set (zhipu provider will fail)${NC}"
  MISSING=1
fi
if [ -z "$DEEPSEEK_API_KEY" ]; then
  echo -e "${Y}WARNING: DEEPSEEK_API_KEY not set (deepseek provider will fail)${NC}"
  MISSING=1
fi
if [ "$MISSING" -eq 1 ]; then
  echo -e "${Y}Set API keys in your shell profile or .env file${NC}"
  echo ""
fi

# Start Router
node "$SRC_DIR/gateway.mjs" &
echo $! >> "$PID_FILE"

echo -e "  ${G}Router${NC}    → http://127.0.0.1:9997/_viewer/"
echo ""
echo -e "  Logs: $SCRIPT_DIR/logs/router/"
echo -e "  PIDs: $PID_FILE"
echo -e "  Stop: ${Y}bash $SCRIPT_DIR/stop.sh${NC}"
echo -e "  Reload: ${Y}bash $SCRIPT_DIR/reload.sh${NC}"
echo ""

# Keep running in foreground (Ctrl+C to stop)
wait
