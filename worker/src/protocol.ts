/**
 * bb-friends wire protocol (v1): JSON text frames over one WebSocket per
 * client per room.
 *
 * THIS FILE IS COPIED VERBATIM to plugin/lib/protocol.ts. Edit worker/src's
 * copy, then run `npm run sync:protocol` at the repo root. The plugin test
 * suite fails if the copies drift.
 *
 * Dependency-free on purpose: it runs in the Worker, in Node, and in tests.
 *
 * Privacy contract: the only thing about a user's bb that ever crosses this
 * protocol is `Status` (state, project NAME, active-thread COUNT, provider id)
 * plus the display name they chose. No titles, prompts, paths or content.
 */

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Largest accepted client frame, in UTF-8 bytes. */
  maxMessageBytes: 1024,
  nameMax: 24,
  projectMax: 40,
  providerMax: 32,
  maxThreads: 999,
  maxMembers: 20,
  /** Entries kept in a room's activity ring buffer. */
  feedSize: 50,
  clientIdMin: 16,
  clientIdMax: 64,
} as const;

export const STATES = ["online", "busy", "idle"] as const;
export type PresenceState = (typeof STATES)[number];

export const REACTIONS = ["👍", "🎉", "🙌", "🔥", "❤️", "😂"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** Everything a friend may learn about your bb. Nothing else is ever sent. */
export interface Status {
  state: PresenceState;
  /** Name of the bb project you are working in; never a path. */
  project: string | null;
  /** How many threads are running right now. */
  threads: number;
  /** Provider id such as "claude-code" or "codex". */
  provider: string | null;
}

export const DEFAULT_STATUS: Status = {
  state: "online",
  project: null,
  threads: 0,
  provider: null,
};

export interface Member {
  id: string;
  name: string;
  status: Status;
  /** Epoch ms when this member joined the room. */
  since: number;
}

export type FeedKind =
  | "joined"
  | "left"
  | "busy"
  | "idle"
  | "poke"
  | "react"
  | "done";

export interface FeedEntry {
  id: number;
  at: number;
  kind: FeedKind;
  who: string;
  whoId: string;
  target?: string;
  targetId?: string;
  emoji?: string;
}

export interface PersonRef {
  id: string;
  name: string;
}

// ── client → server ────────────────────────────────────────────────────────

export type ClientMessage =
  | { t: "hello"; v: number; cid: string; name: string; status?: Status }
  | { t: "status"; status: Status }
  | { t: "poke"; to: string }
  | { t: "react"; to: string; emoji: Reaction }
  /** "I finished a thread": shows up in the feed, invites a high-five. */
  | { t: "done" };

// ── server → client ────────────────────────────────────────────────────────

export type ServerMessage =
  | {
      t: "welcome";
      v: number;
      you: string;
      members: Member[];
      feed: FeedEntry[];
    }
  /** Delta: one member joined or changed status. */
  | { t: "member"; member: Member }
  /** Delta: one member went offline. */
  | { t: "left"; id: string }
  | { t: "feed"; entry: FeedEntry }
  | { t: "poke"; from: PersonRef; at: number }
  | { t: "react"; from: PersonRef; emoji: Reaction; at: number }
  | { t: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "bad_message"
  | "too_large"
  | "not_joined"
  | "already_joined"
  | "room_full"
  | "unknown_member"
  | "self_target"
  | "rate_limited"
  | "version";

/** WebSocket close codes the server uses (4000–4999 are application codes). */
export const CLOSE = {
  replaced: 4000,
  badHello: 4001,
  roomFull: 4003,
  helloTimeout: 4008,
} as const;

// ── room codes ─────────────────────────────────────────────────────────────

/** 32 symbols, no 0/O/1/I: 256 % 32 === 0, so random bytes map without bias. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 10; // 50 bits of entropy
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{8,16}$/;

/** Cryptographically random invite code. Server-side only in practice. */
export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % 32];
  return code;
}

/** Accepts "abcde-fghij", " ABCDE FGHIJ " etc.; returns null if not a code. */
export function normalizeRoomCode(input: string): string | null {
  const code = input.replace(/[\s-]+/g, "").toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/** Display form: ABCDE-FGHIJ. */
export function formatRoomCode(code: string): string {
  return code.length > 5 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

// ── validation ─────────────────────────────────────────────────────────────

/** Strips control and invisible formatting characters, collapses spaces. */
export function cleanText(value: string, max: number): string {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim()]
    .slice(0, max)
    .join("")
    .trim();
}

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string };

const bad = (message: string, code: ErrorCode = "bad_message"): Parsed<never> => ({
  ok: false,
  code,
  message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const encoder = new TextEncoder();

function parseStatus(value: unknown): Parsed<Status> {
  if (!isRecord(value)) return bad("status must be an object");
  const { state, project, threads, provider } = value;
  if (typeof state !== "string" || !(STATES as readonly string[]).includes(state))
    return bad("status.state must be online, busy or idle");
  if (!(project === null || typeof project === "string"))
    return bad("status.project must be a string or null");
  if (!(provider === null || typeof provider === "string"))
    return bad("status.provider must be a string or null");
  if (
    typeof threads !== "number" ||
    !Number.isInteger(threads) ||
    threads < 0 ||
    threads > LIMITS.maxThreads
  )
    return bad(`status.threads must be an integer 0..${LIMITS.maxThreads}`);
  const cleanProject = project === null ? "" : cleanText(project, LIMITS.projectMax);
  const cleanProvider = provider === null ? "" : cleanText(provider, LIMITS.providerMax);
  return {
    ok: true,
    value: {
      state: state as PresenceState,
      project: cleanProject === "" ? null : cleanProject,
      threads,
      provider: cleanProvider === "" ? null : cleanProvider,
    },
  };
}

/** Parses and validates one client frame. Unknown fields are dropped. */
export function parseClientMessage(raw: string | ArrayBuffer): Parsed<ClientMessage> {
  let text: string;
  if (typeof raw === "string") {
    if (raw.length > LIMITS.maxMessageBytes) return bad("message too large", "too_large");
    text = raw;
  } else {
    if (raw.byteLength > LIMITS.maxMessageBytes) return bad("message too large", "too_large");
    text = new TextDecoder().decode(raw);
  }
  if (encoder.encode(text).length > LIMITS.maxMessageBytes)
    return bad("message too large", "too_large");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return bad("invalid JSON");
  }
  if (!isRecord(json) || typeof json.t !== "string") return bad("missing message type");

  switch (json.t) {
    case "hello": {
      if (json.v !== PROTOCOL_VERSION)
        return bad(`unsupported protocol version, expected ${PROTOCOL_VERSION}`, "version");
      const { cid, name } = json;
      if (
        typeof cid !== "string" ||
        cid.length < LIMITS.clientIdMin ||
        cid.length > LIMITS.clientIdMax ||
        !/^[A-Za-z0-9_-]+$/.test(cid)
      )
        return bad("cid must be 16-64 characters of [A-Za-z0-9_-]");
      if (typeof name !== "string") return bad("name must be a string");
      const cleanName = cleanText(name, LIMITS.nameMax);
      if (cleanName === "") return bad("name must not be empty");
      let status: Status | undefined;
      if (json.status !== undefined) {
        const parsed = parseStatus(json.status);
        if (!parsed.ok) return parsed;
        status = parsed.value;
      }
      return {
        ok: true,
        value: {
          t: "hello",
          v: PROTOCOL_VERSION,
          cid,
          name: cleanName,
          ...(status ? { status } : {}),
        },
      };
    }
    case "status": {
      const parsed = parseStatus(json.status);
      if (!parsed.ok) return parsed;
      return { ok: true, value: { t: "status", status: parsed.value } };
    }
    case "poke": {
      if (typeof json.to !== "string" || json.to.length === 0 || json.to.length > 32)
        return bad("to must be a member id");
      return { ok: true, value: { t: "poke", to: json.to } };
    }
    case "react": {
      if (typeof json.to !== "string" || json.to.length === 0 || json.to.length > 32)
        return bad("to must be a member id");
      if (typeof json.emoji !== "string" || !(REACTIONS as readonly string[]).includes(json.emoji))
        return bad("emoji is not an allowed reaction");
      return {
        ok: true,
        value: { t: "react", to: json.to, emoji: json.emoji as Reaction },
      };
    }
    case "done":
      return { ok: true, value: { t: "done" } };
    default:
      return bad("unknown message type");
  }
}

export const statusEquals = (a: Status, b: Status): boolean =>
  a.state === b.state &&
  a.project === b.project &&
  a.threads === b.threads &&
  a.provider === b.provider;
