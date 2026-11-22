#!/usr/bin/env bash
# Starts `wrangler dev`, runs the two-client end-to-end test against it, stops it.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
LOG="${TMPDIR:-/tmp}/bb-friends-wrangler.log"
# Fresh local state per run, so repeated runs never trip the per-IP
# room-creation limit (all local requests come from one address).
STATE="$(mktemp -d "${TMPDIR:-/tmp}/bb-friends-e2e.XXXXXX")"

(cd worker && npx wrangler dev --port "$PORT" --local --persist-to "$STATE" >"$LOG" 2>&1) &
WRANGLER_PID=$!
trap 'kill $WRANGLER_PID 2>/dev/null || true; pkill -P $WRANGLER_PID 2>/dev/null || true; rm -rf "$STATE"' EXIT

for _ in $(seq 1 60); do
  if curl -fs "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fs "http://localhost:$PORT/health" >/dev/null || { echo "wrangler dev did not start:"; cat "$LOG"; exit 1; }

(cd plugin && FRIENDS_URL="http://localhost:$PORT" npx vitest run --config vitest.e2e.config.ts)
