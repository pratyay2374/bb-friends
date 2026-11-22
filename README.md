# bb-friends

A small, fun bb plugin: make an invite-code room, see which friends are **busy / idle / online** in bb, watch a live activity feed, **poke** each other (it shows up as a bb toast), send emoji reactions, and get a 🎉 when a friend's long thread finishes (with a one-click 🙌 high-five back).

```
plugin/   the bb plugin (TypeScript, @get-bb/plugin-sdk)
worker/   the Cloudflare backend (a thin Worker + one Durable Object per room)
scripts/  e2e.sh: runs two simulated clients against a real `wrangler dev`
```

## What leaves your machine

**Status only.** For each user the room sees:

| field      | example                | notes                                    |
| ---------- | ---------------------- | ---------------------------------------- |
| `state`    | `busy` / `idle` / `online` | derived locally from bb thread state |
| `project`  | `bb-friends`           | the project **name**, never a path       |
| `threads`  | `2`                    | how many threads are running             |
| `provider` | `claude-code`          | provider id                              |
| name       | `Ada`                  | the display name you chose               |

Never thread titles, prompts, file paths, ids or message content. This is enforced by construction, not by filtering: status derivation (`plugin/lib/status.ts`) reads a whitelist of thread fields, and the tracker only ever stores that whitelist. Tests feed it full thread objects with secret titles/paths and assert none appear in the status or in any frame sent over the socket (`plugin/test/status.test.ts`, `plugin/test/server.test.ts`). The worker also drops unknown fields. Switch **Share project name and provider** off in the plugin settings to share only state + thread count.

## Why a Durable Object (and not just a Worker)

A plain Worker is stateless: it can't hold a WebSocket open across requests, and can't fan a message out to the other people in a room. KV is eventually consistent and slow for something like presence. A **Durable Object gives each room one single-threaded coordinator** with strongly consistent state and low-latency WebSocket fan-out.

- **Worker** (`worker/src/index.ts`): stateless edge router. Validates the URL, mints invite codes, forwards `/rooms/:code/ws` to the room's DO. No state.
- **`Room` Durable Object** (`worker/src/room.ts`): one per invite code.
  - **WebSocket Hibernation API** (`ctx.acceptWebSocket`, `serializeAttachment`): each member's state lives in their socket's attachment, so an idle room is evicted from memory and costs nothing; the next message wakes it. Keepalive `ping`/`pong` is answered by the runtime via `setWebSocketAutoResponse` without waking the object.
  - **Deltas, not snapshots**: a full `welcome` on join, then single `member` / `left` / `feed` frames. An unchanged status sends nothing.
  - **Activity ring buffer** (last 50) in the DO's SQLite storage (`new_sqlite_classes`), replayed to newcomers.
  - **Rate limits**: pokes 6/min, reactions 20/min, "finished" cheers 6/min per sender, kept durably in SQLite and keyed by the sender's private client id, so reconnecting or hibernating doesn't reset them. Status updates are flood-limited per socket.
  - **Validation**: every client frame is parsed by `worker/src/protocol.ts`: ≤1 KB (counted in bytes), strict types, whitelisted emoji, control/bidi characters stripped from names, unknown fields dropped.
  - **Invite codes** are minted by the Worker, 10 chars from a 32-symbol alphabet using `crypto.getRandomValues` (50 bits). Clients can't pick codes, and the DO refuses sockets to rooms that were never created.
  - **Identity**: the server assigns each member's public id; the client's stable install id (`cid`) is never broadcast, so nobody can impersonate a friend. Reconnecting with the same `cid` takes over the old connection quietly.
  - **Cleanup**: an empty room is wiped 7 days after its last member leaves (DO alarm). Sockets that never say hello are closed after 15 s. Max 20 members per room.

Protocol and limits live in one dependency-free file, `worker/src/protocol.ts`, copied verbatim to `plugin/lib/protocol.ts` (`npm run sync:protocol`; a test fails if they drift).

## Local development

Requires Node 22+.

```sh
npm run install:all          # installs worker/ and plugin/ dependencies
npm run check                # typecheck + all tests + plugin build
```

### Run the backend: `wrangler dev`

```sh
npm run dev:worker           # = cd worker && wrangler dev  → http://localhost:8787
curl -X POST localhost:8787/rooms     # → {"code":"K7M2Q9XWPA"}
```

### End-to-end proof (two clients, one room, a poke)

```sh
npm run e2e                  # boots wrangler dev, runs two simulated clients, stops it
```

The clients are built from the plugin's real connection + state code; the test asserts both see each other's presence, a status delta, a poke delivered to the target only, a reaction, and a leave.

### Install the plugin into bb

```sh
cd plugin
bb plugin build              # builds dist/ (also happens on install)
bb plugin install .          # registers this directory in place
bb plugin dev                # optional: rebuild + reload on every save
```

Then open **Friends** in bb's sidebar, pick a display name, **Create a room**, and send the code to a friend. The plugin server (not the browser) keeps the WebSocket, so your status stays live even when the Friends page is closed; pokes appear as toasts anywhere in bb.

Settings (Settings → Installed plugins, or the CLI):

```sh
bb plugin config friends set serverUrl http://localhost:8787
bb plugin config friends set displayName Ada
bb plugin config friends set shareDetails false     # share state + count only
bb plugin config friends set celebrate false        # don't announce finished threads
```

`serverUrl` defaults to `http://localhost:8787`. Use the `https://` URL after deploying (the plugin switches to `wss://`).

## Deploy (when you're ready)

Not run by this repo's tooling. You do it:

```sh
cd worker
npx wrangler login
npx wrangler deploy          # prints https://bb-friends.<your-subdomain>.workers.dev
```

The first deploy applies the `v1` migration that creates the SQLite-backed `Room` class. Then point the plugin at it:

```sh
bb plugin config friends set serverUrl https://bb-friends.<your-subdomain>.workers.dev
```

Durable Objects with SQLite storage are available on the Workers Free plan (check Cloudflare's current limits and pricing for your account). Before sharing the URL widely, consider a Cloudflare rate-limiting rule on `POST /rooms` (room creation is not limited per IP in the Worker).

## Layout

```
worker/
  wrangler.jsonc          DO binding, SQLite migration, compat date
  src/index.ts            router: POST /rooms, GET /rooms/:code, GET /rooms/:code/ws
  src/room.ts             the Room Durable Object
  src/protocol.ts         wire protocol, limits, validation, room codes
  test/                   vitest + @cloudflare/vitest-plugin (runs in workerd)
plugin/
  server.ts               plugin backend: settings, thread events → status, socket, RPC
  app.tsx                 frontend: Friends page + toast notifier
  lib/status.ts           local status derivation (whitelist; no titles/paths)
  lib/connection.ts       WebSocket client: hello, ping, watchdog, backoff
  lib/room-state.ts       pure reducer for server frames
  test/                   vitest (fake bb host, fake sockets, protocol-sync)
  e2e/                    two-client test against a live wrangler dev
```

## Known limits

- No accounts: anyone with the invite code can join. Treat the code like a password; leave and make a new room to rotate it.
- Display names aren't unique, and a room's friends are only those currently connected (no persistent roster).
- The plugin relies on a global `WebSocket` in bb's plugin runtime (Node 22+). It is covered by tests with a fake socket, but has not been run inside a live bb here.
