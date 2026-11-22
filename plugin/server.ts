import { randomBytes } from "node:crypto";
import {
  experimental_PluginRpcRefusal as Refusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

import { FriendsConnection, type SocketLike } from "./lib/connection";
import { LIMITS, cleanText, type ServerMessage } from "./lib/protocol";
import { applyServerMessage, emptyView, type RoomView } from "./lib/room-state";
import {
  CHANNEL_CHANGED,
  CHANNEL_NOTICE,
  CHANNEL_POKE,
  CHANNEL_REACT,
  rpcContract,
  type FriendsView,
  type NoticePayload,
  type PokePayload,
  type ReactPayload,
} from "./lib/rpc";
import {
  normalizeRoomCode,
  parseServerUrl,
  roomSocketUrl,
  roomUrl,
  roomsUrl,
} from "./lib/server-url";
import { deriveStatus } from "./lib/status";
import { ThreadTracker } from "./lib/tracker";

export { rpcContract };

const KV_ROOM = "room";
const KV_CID = "client-id";
/** A thread must have run this long before finishing it earns a cheer. */
const CELEBRATE_AFTER_MS = 2 * 60 * 1000;
/** Thread events are bursty; send one status after they settle. */
const STATUS_DEBOUNCE_MS = 400;
const REQUEST_TIMEOUT_MS = 8_000;

export interface PluginDeps {
  createSocket: (url: string) => SocketLike;
  fetch?: typeof fetch;
  now?: () => number;
}

const realSocket = (url: string): SocketLike => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!Ctor) throw new Error("this runtime has no global WebSocket (needs Node 22+)");
  return new Ctor(url);
};

export function createPlugin(deps: PluginDeps) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  return async function plugin(bb: BbPluginApi): Promise<void> {
    const { kv } = bb.storage;
    const settings = bb.settings.define({
      serverUrl: {
        type: "string",
        label: "Friends server URL",
        default: "http://localhost:8787",
        experimental_schema: z.string().max(200),
      },
      displayName: {
        type: "string",
        label: "Display name",
        default: "",
        experimental_schema: z.string().max(LIMITS.nameMax * 4),
      },
      shareDetails: {
        type: "boolean",
        label: "Share project name and provider with friends",
        default: true,
      },
      celebrate: {
        type: "boolean",
        label: "Tell friends when a long-running thread finishes",
        default: true,
      },
    });

    let current = await settings.get();
    let room = (await kv.get<string>(KV_ROOM)) ?? null;
    let cid = await kv.get<string>(KV_CID);
    if (!cid) {
      cid = randomBytes(16).toString("hex");
      await kv.set(KV_CID, cid);
    }
    const clientId = cid;

    const tracker = new ThreadTracker();
    const projectNames = new Map<string, string>();
    let view: RoomView = emptyView();
    let connection: FriendsConnection | null = null;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    let projectsRefreshedAt = 0;

    const publish = () => bb.realtime.publish(CHANNEL_CHANGED, null);
    const effectiveName = () =>
      cleanText(current.displayName, LIMITS.nameMax) || `Friend ${clientId.slice(0, 4)}`;
    const currentStatus = () =>
      deriveStatus(tracker.facts(), { projectNames, shareDetails: current.shareDetails });

    const toView = (): FriendsView => ({
      ...view,
      room,
      name: effectiveName(),
      serverUrl: current.serverUrl,
    });

    // ── connection ───────────────────────────────────────────────────────

    const handleMessage = (message: ServerMessage) => {
      if (message.t === "poke")
        bb.realtime.publish(CHANNEL_POKE, { fromName: message.from.name, at: message.at } satisfies PokePayload);
      else if (message.t === "react")
        bb.realtime.publish(CHANNEL_REACT, {
          fromName: message.from.name,
          emoji: message.emoji,
          at: message.at,
        } satisfies ReactPayload);
      else if (message.t === "error")
        bb.realtime.publish(CHANNEL_NOTICE, { message: message.message } satisfies NoticePayload);
      view = applyServerMessage(view, message);
      publish();
    };

    const connect = () => {
      connection?.stop();
      connection = null;
      const base = parseServerUrl(current.serverUrl);
      if (room === null) {
        view = emptyView();
      } else if (base === null) {
        view = { ...emptyView(), error: "The friends server URL is not a valid http(s) URL." };
      } else {
        view = emptyView("connecting");
        connection = new FriendsConnection({
          url: roomSocketUrl(base, room),
          cid: clientId,
          name: effectiveName(),
          getStatus: currentStatus,
          createSocket: deps.createSocket,
          onMessage: handleMessage,
          onState: (connectionState) => {
            view =
              connectionState === "connected"
                ? { ...view, connection: connectionState }
                : { ...view, connection: connectionState, you: null, members: [] };
            publish();
          },
          onFatal: (reason) => {
            view = { ...view, error: reason };
            publish();
          },
          log: (line) => bb.log.warn(line),
        });
        connection.start();
      }
      publish();
    };

    const pushStatus = () => {
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => {
        connection?.send({ t: "status", status: currentStatus() });
      }, STATUS_DEBOUNCE_MS);
    };

    // ── thread tracking ──────────────────────────────────────────────────

    const refreshProjects = async () => {
      if (now() - projectsRefreshedAt < 30_000) return;
      projectsRefreshedAt = now();
      try {
        for (const project of await bb.sdk.projects.list({ includePersonal: true }))
          projectNames.set(project.id, project.name);
        pushStatus();
      } catch (cause) {
        bb.log.warn(`could not list projects: ${String(cause)}`);
      }
    };

    const reconcile = async () => {
      try {
        await refreshProjects();
        for (let offset = 0; ; offset += 200) {
          const page = await bb.sdk.threads.list({ archived: false, limit: 200, offset });
          for (const thread of page) tracker.upsert(thread);
          if (page.length < 200) break;
        }
      } catch (cause) {
        bb.log.warn(`could not list threads: ${String(cause)}`);
      }
    };

    type EventThread = Parameters<typeof tracker.upsert>[0];
    const observe = (thread: EventThread, status?: string) => {
      tracker.upsert(thread, status);
      if (!projectNames.has(thread.projectId)) void refreshProjects();
      pushStatus();
    };

    bb.events.on("thread.created", ({ thread }) => observe(thread));
    bb.events.on("thread.unarchived", ({ thread }) => observe(thread));
    bb.events.on("thread.active", ({ thread }) => {
      tracker.markActive(thread.id, now());
      observe(thread, "active");
    });
    bb.events.on("thread.failed", ({ thread }) => {
      tracker.finish(thread.id, now());
      observe(thread, "error");
    });
    bb.events.on("thread.idle", ({ thread }) => {
      const ranFor = tracker.finish(thread.id, now());
      observe(thread, "idle");
      if (
        current.celebrate &&
        ranFor !== null &&
        ranFor >= CELEBRATE_AFTER_MS &&
        thread.parentThreadId === null
      )
        connection?.send({ t: "done" });
    });
    const forget = ({ thread }: { thread: { id: string } }) => {
      tracker.remove(thread.id);
      pushStatus();
    };
    bb.events.on("thread.archived", forget);
    bb.events.on("thread.deleted", forget);

    settings.onChange((next, prev) => {
      current = next;
      if (next.serverUrl !== prev.serverUrl || next.displayName !== prev.displayName) connect();
      else if (next.shareDetails !== prev.shareDetails) pushStatus();
    });

    // ── lifecycle ────────────────────────────────────────────────────────

    bb.background.service("friends", {
      async start(signal) {
        await reconcile();
        if (signal.aborted) return;
        connect();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        connection?.stop();
      },
    });
    bb.onDispose(() => {
      clearTimeout(statusTimer);
      connection?.stop();
      connection = null;
    });

    // ── RPC ──────────────────────────────────────────────────────────────

    const baseUrl = () => {
      const base = parseServerUrl(current.serverUrl);
      if (!base)
        throw new Refusal({ code: "invalid", message: "Set a valid friends server URL in the plugin settings." });
      return base;
    };

    const request = async (url: string, init?: RequestInit): Promise<unknown> => {
      let response: Response;
      try {
        response = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch {
        throw new Refusal({
          code: "conflict",
          message: `Can't reach the friends server at ${current.serverUrl}. Is it running (wrangler dev)?`,
        });
      }
      if (!response.ok)
        throw new Refusal({ code: "conflict", message: `The friends server answered ${response.status}.` });
      return response.json();
    };

    const enter = async (code: string) => {
      room = code;
      await kv.set(KV_ROOM, code);
      connect();
      return { code };
    };

    const send = (message: Parameters<FriendsConnection["send"]>[0]) => {
      if (!connection?.send(message))
        throw new Refusal({ code: "conflict", message: "Not connected to the room right now." });
      return { sent: true };
    };

    bb.rpc.register(rpcContract, {
      state: () => toView(),
      async createRoom() {
        const body = await request(roomsUrl(baseUrl()), { method: "POST" });
        const code = normalizeRoomCode(String((body as { code?: unknown })?.code ?? ""));
        if (code === null)
          throw new Refusal({ code: "conflict", message: "The server returned a malformed room code." });
        return enter(code);
      },
      async joinRoom({ code: raw }) {
        const code = normalizeRoomCode(raw);
        if (code === null)
          throw new Refusal({ code: "invalid", message: "That doesn't look like an invite code." });
        const body = await request(roomUrl(baseUrl(), code));
        if ((body as { exists?: unknown })?.exists !== true)
          throw new Refusal({ code: "not_found", message: "No room with that code." });
        return enter(code);
      },
      async leaveRoom() {
        const left = room !== null;
        room = null;
        await kv.delete(KV_ROOM);
        connect();
        return { left };
      },
      async setName({ name }) {
        const clean = cleanText(name, LIMITS.nameMax);
        if (clean === "") throw new Refusal({ code: "invalid", message: "Pick a name." });
        await settings.experimental_set({ displayName: clean });
        return { name: clean };
      },
      poke: ({ to }) => send({ t: "poke", to }),
      react: ({ to, emoji }) => send({ t: "react", to, emoji }),
    });
  };
}

export default createPlugin({ createSocket: realSocket });
