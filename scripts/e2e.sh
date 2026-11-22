#!/usr/bin/env bash
# Starts `wrangler dev`, runs the two-client end-to-end test against it, stops it.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
LOG="${TMPDIR:-/tmp}/bb-friends-wrangler.log"

# Refuse to run if something already listens on $PORT (e.g. your own
# `npm run dev:worker`): the test would silently run against that server.
# curl exits 7 only when nothing accepts the connection.
port_status=0
curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/" || port_status=$?
if [ "$port_status" -ne 7 ]; then
  echo "e2e: port $PORT is already in use. Stop whatever is on it, or pick a free port: PORT=8788 npm run e2e" >&2
  exit 1
fi

# Fresh local state per run, so repeated runs never trip the per-IP
# room-creation limit (all local requests come from one address).
STATE="$(mktemp -d "${TMPDIR:-/tmp}/bb-friends-e2e.XXXXXX")"

# Job control puts the background job in its own process group, so cleanup
# can signal wrangler and everything it spawned (workerd) in one go. `exec`
# makes the group leader wrangler itself rather than a wrapper shell or npx.
set -m
(cd worker && exec ./node_modules/.bin/wrangler dev --port "$PORT" --local --persist-to "$STATE" >"$LOG" 2>&1) &
WRANGLER_PGID=$!
set +m

cleanup() {
  kill -TERM -- "-$WRANGLER_PGID" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 -- "-$WRANGLER_PGID" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL -- "-$WRANGLER_PGID" 2>/dev/null || true
  rm -rf "$STATE"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for _ in $(seq 1 60); do
  if curl -fs "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fs "http://localhost:$PORT/health" >/dev/null || { echo "wrangler dev did not start:"; cat "$LOG"; exit 1; }

(cd plugin && FRIENDS_URL="http://localhost:$PORT" npx vitest run --config vitest.e2e.config.ts)
