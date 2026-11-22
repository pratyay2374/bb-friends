import { DurableObject } from "cloudflare:workers";

import { RATE_SCHEMA, takeToken } from "./limiter";

import {
  CLOSE,
  DEFAULT_STATUS,
  LIMITS,
  PROTOCOL_VERSION,
  parseAvatar,
  parseClientMessage,
  statusEquals,
  type Avatar,
  type ClientMessage,
  type ErrorCode,
  type FeedEntry,
  type FeedKind,
  type Member,
  type PersonRef,
  type ServerMessage,
  type Status,
} from "./protocol";

/**
 * One Room per invite code. It is the single coordinator for that room:
 * presence, fan-out, the activity ring buffer and rate limits all live here.
 *
 * Hibernation: sockets are accepted with `ctx.acceptWebSocket`, and each
 * member's state lives in the socket's attachment (survives eviction), so an
 * idle room is evicted from memory and costs nothing; the next message wakes
 * it and the constructor has nothing to rebuild. Presence is always derived
 * from `ctx.getWebSockets()`.
 */

/** Per-socket state, kept in the (<= 2 KB) hibernation attachment. */
interface Attachment {
  /** Stable per-install client id. Private: never sent to other members. */
  cid: string;
  /** Public member id, assigned here, used as the poke/react target. */
  id: string;
  name: string;
  status: Status;
  avatar?: Avatar;
  since: number;
}

interface Pending {
  /** Connected but no valid `hello` yet. */
  pendingSince: number;
}

type SocketState = Attachment | Pending;

const isJoined = (state: SocketState | null): state is Attachment =>
  state !== null && "cid" in state;

/** How long a socket may stay connected without saying hello. */
const HELLO_TIMEOUT_MS = 15_000;
/** An empty room's data is wiped this long after its last member leaves. */
const EMPTY_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-socket status flood guard (in memory; a flood keeps the DO awake). */
const STATUS_WINDOW_MS = 10_000;
const STATUS_MAX_PER_WINDOW = 20;

/** Durable per-sender limits for fan-out actions, keyed by client id. */
const RATE_LIMITS = {
  poke: { max: 6, windowMs: 60_000 },
  react: { max: 20, windowMs: 60_000 },
  done: { max: 6, windowMs: 60_000 },
} as const;
type RateKind = keyof typeof RATE_LIMITS;

const randomId = (): string => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export class Room extends DurableObject<Env> {
  private readonly statusTimes = new WeakMap<WebSocket, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
    // Answered by the runtime without waking a hibernated object, so clients
    // can keepalive through proxies for free.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feed (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        who_id TEXT NOT NULL,
        who TEXT NOT NULL,
        target_id TEXT,
        target TEXT,
        emoji TEXT,
        avatar TEXT
      );
    `);
    const sql = this.ctx.storage.sql;
    if (!sql.exec<{ name: string }>("PRAGMA table_info(feed)").toArray().some(({ name }) => name === "avatar")) {
      sql.exec("ALTER TABLE feed ADD COLUMN avatar TEXT");
    }
    sql.exec(RATE_SCHEMA);
  }

  // ── RPC from the Worker ──────────────────────────────────────────────────

  /** Marks the room as created. Returns false if it already existed. */
  async init(): Promise<boolean> {
    const existing = this.exists();
    if (existing) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (k, v) VALUES ('created', ?)",
      String(Date.now()),
    );
    return true;
  }

  exists(): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 AS x FROM meta WHERE k = 'created'")
        .toArray().length > 0
    );
  }

  // ── WebSocket upgrade ────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected websocket", { status: 426 });
    if (!this.exists()) return new Response("no such room", { status: 404 });
    if (this.ctx.getWebSockets().length >= LIMITS.maxMembers * 2)
      return new Response("room is full", { status: 503 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pendingSince: Date.now() } satisfies Pending);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── hibernation handlers ─────────────────────────────────────────────────

  override async webSocketMessage(
    ws: WebSocket,
    raw: string | ArrayBuffer,
  ): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.sendError(ws, parsed.code, parsed.message);
      if (parsed.code === "too_large") ws.close(CLOSE.badHello, "message too large");
      return;
    }
    const msg = parsed.value;
    const state = ws.deserializeAttachment() as SocketState | null;

    if (msg.t === "hello") {
      if (isJoined(state)) return this.sendError(ws, "already_joined", "already joined");
      return this.onHello(ws, msg);
    }
    if (!isJoined(state)) {
      this.sendError(ws, "not_joined", "send hello first");
      ws.close(CLOSE.badHello, "hello required");
      return;
    }

    switch (msg.t) {
      case "status":
        return this.onStatus(ws, state, msg.status, msg.avatar);
      case "poke":
        return this.onTargeted(ws, state, "poke", msg.to);
      case "react":
        return this.onTargeted(ws, state, "react", msg.to, msg.emoji);
      case "done":
        return this.onDone(ws, state);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  override async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      // Nobody came back within the TTL: forget the room entirely.
      await this.ctx.storage.deleteAll();
      // deleteAll drops the tables too; the instance may live on briefly.
      this.ensureSchema();
      return;
    }
    const now = Date.now();
    let stillPending = false;
    for (const ws of sockets) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (state !== null && !isJoined(state)) {
        if (now - state.pendingSince >= HELLO_TIMEOUT_MS) {
          ws.close(CLOSE.helloTimeout, "hello timeout");
        } else stillPending = true;
      }
    }
    if (stillPending) await this.ctx.storage.setAlarm(now + HELLO_TIMEOUT_MS);
  }

  // ── message handlers ─────────────────────────────────────────────────────

  private onHello(ws: WebSocket, msg: Extract<ClientMessage, { t: "hello" }>): void {
    const others = this.joined().filter((entry) => entry.ws !== ws);
    // The same install reconnecting: take over its identity, retire the old
    // socket quietly, so peers see one continuous member, not leave + join.
    const previous = others.find((entry) => entry.state.cid === msg.cid);
    if (!previous && others.length >= LIMITS.maxMembers) {
      this.sendError(ws, "room_full", "this room is full");
      ws.close(CLOSE.roomFull, "room full");
      return;
    }

    const now = Date.now();
    const attachment: Attachment = {
      cid: msg.cid,
      id: previous?.state.id ?? randomId(),
      name: msg.name,
      status: msg.status ?? DEFAULT_STATUS,
      ...(msg.avatar ? { avatar: msg.avatar } : {}),
      since: previous?.state.since ?? now,
    };
    ws.serializeAttachment(attachment);

    if (previous) {
      // Mark replaced so its close handler stays silent.
      previous.ws.serializeAttachment({ pendingSince: 0 } satisfies Pending);
      previous.ws.close(CLOSE.replaced, "replaced by a newer connection");
    }

    this.send(ws, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      you: attachment.id,
      members: this.members(),
      feed: this.recentFeed(),
    });
    this.broadcast({ t: "member", member: toMember(attachment) }, ws);
    if (!previous) this.record("joined", attachment);
  }

  private onStatus(ws: WebSocket, state: Attachment, status: Status, avatar?: Avatar): void {
    const now = Date.now();
    const times = (this.statusTimes.get(ws) ?? []).filter(
      (t) => now - t < STATUS_WINDOW_MS,
    );
    if (times.length >= STATUS_MAX_PER_WINDOW) {
      this.statusTimes.set(ws, times);
      return this.sendError(ws, "rate_limited", "too many status updates");
    }
    times.push(now);
    this.statusTimes.set(ws, times);

    const avatarChanged = avatar && (avatar.style !== state.avatar?.style || avatar.seed !== state.avatar?.seed);
    if (statusEquals(state.status, status) && !avatarChanged) return;
    const next: Attachment = { ...state, status, ...(avatar ? { avatar } : {}) };
    ws.serializeAttachment(next);
    this.broadcast({ t: "member", member: toMember(next) }, ws);
    if (state.status.state !== status.state) {
      if (status.state === "busy") this.record("busy", next);
      else if (status.state === "idle") this.record("idle", next);
    }
  }

  private onTargeted(
    ws: WebSocket,
    state: Attachment,
    kind: "poke" | "react",
    targetId: string,
    emoji?: Extract<ClientMessage, { t: "react" }>["emoji"],
  ): void {
    if (targetId === state.id)
      return this.sendError(ws, "self_target", "you cannot target yourself");
    const target = this.joined().find((entry) => entry.state.id === targetId);
    if (!target) return this.sendError(ws, "unknown_member", "that friend is not here");
    if (!this.allow(state.cid, kind))
      return this.sendError(ws, "rate_limited", `slow down: too many ${kind}s`);

    const from: PersonRef = { id: state.id, name: state.name };
    const at = Date.now();
    this.send(
      target.ws,
      kind === "poke"
        ? { t: "poke", from, at }
        : { t: "react", from, emoji: emoji!, at },
    );
    this.record(kind, state, target.state, emoji);
  }

  private onDone(ws: WebSocket, state: Attachment): void {
    if (!this.allow(state.cid, "done"))
      return this.sendError(ws, "rate_limited", "too many updates");
    this.record("done", state);
  }

  private onGone(ws: WebSocket): void {
    const state = ws.deserializeAttachment() as SocketState | null;
    if (isJoined(state)) {
      this.broadcast({ t: "left", id: state.id }, ws);
      this.record("left", state, undefined, undefined, ws);
    }
    // Last one out: schedule the room to be forgotten if nobody returns.
    const remaining = this.ctx.getWebSockets().filter((other) => other !== ws);
    if (remaining.length === 0) {
      void this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private joined(): { ws: WebSocket; state: Attachment }[] {
    const out: { ws: WebSocket; state: Attachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (isJoined(state)) out.push({ ws, state });
    }
    return out;
  }

  private members(): Member[] {
    return this.joined().map((entry) => toMember(entry.state));
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket already closing; its close handler cleans up.
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { t: "error", code, message });
  }

  /** Sends one delta to every joined socket except `except`. */
  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const frame = JSON.stringify(message);
    for (const { ws } of this.joined()) {
      if (ws === except) continue;
      try {
        ws.send(frame);
      } catch {
        // see send()
      }
    }
  }

  /** Appends to the ring buffer and broadcasts the entry to everyone. */
  private record(
    kind: FeedKind,
    who: Attachment,
    target?: Attachment,
    emoji?: string,
    exclude?: WebSocket,
  ): void {
    const at = Date.now();
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ id: number }>(
        `INSERT INTO feed (at, kind, who_id, who, target_id, target, emoji, avatar)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        at,
        kind,
        who.id,
        who.name,
        target?.id ?? null,
        target?.name ?? null,
        emoji ?? null,
        who.avatar ? JSON.stringify(who.avatar) : null,
      )
      .one();
    sql.exec("DELETE FROM feed WHERE id <= ?", row.id - LIMITS.feedSize);
    const entry: FeedEntry = {
      id: row.id,
      at,
      kind,
      who: who.name,
      whoId: who.id,
      ...(who.avatar ? { avatar: who.avatar } : {}),
      ...(target ? { target: target.name, targetId: target.id } : {}),
      ...(emoji ? { emoji } : {}),
    };
    this.broadcast({ t: "feed", entry }, exclude);
  }

  private recentFeed(): FeedEntry[] {
    return this.ctx.storage.sql
      .exec<{
        id: number;
        at: number;
        kind: FeedKind;
        who_id: string;
        who: string;
        target_id: string | null;
        target: string | null;
        emoji: string | null;
        avatar: string | null;
      }>("SELECT * FROM feed ORDER BY id DESC LIMIT ?", LIMITS.feedSize)
      .toArray()
      .reverse()
      .map((row) => {
        const avatar = row.avatar === null ? undefined : parseAvatar(JSON.parse(row.avatar));
        return {
          id: row.id,
          at: row.at,
          kind: row.kind,
          who: row.who,
          whoId: row.who_id,
          ...(avatar ? { avatar } : {}),
          ...(row.target !== null && row.target_id !== null
            ? { target: row.target, targetId: row.target_id }
            : {}),
          ...(row.emoji !== null ? { emoji: row.emoji } : {}),
        };
      });
  }

  /**
   * Durable sliding-window limiter, keyed by the sender's private client id so
   * reconnecting does not reset it and surviving hibernation is free.
   */
  private allow(cid: string, kind: RateKind): boolean {
    const { max, windowMs } = RATE_LIMITS[kind];
    return takeToken(this.ctx.storage.sql, `${kind}:${cid}`, max, windowMs).ok;
  }
}

const toMember = (state: Attachment): Member => ({
  id: state.id,
  name: state.name,
  status: state.status,
  since: state.since,
  ...(state.avatar ? { avatar: state.avatar } : {}),
});
