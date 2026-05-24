#!/bin/bash
# Stop all Router monitor processes
PID_FILE="$(cd "$(dirname "$0")" && pwd)/.pids"

if [ -f "$PID_FILE" ]; then
  echo "Stopping monitors..."
  while read pid; do
    kill "$pid" 2>/dev/null && echo "  Killed PID $pid" || echo "  PID $pid already gone"
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# Also kill by port
for port in 9997; do
  pids=$(lsof -ti :$port 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "  Killing port $port: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
done

echo "Done."
