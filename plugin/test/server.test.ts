import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SocketLike } from "../lib/connection";
import type { Avatar, ClientMessage } from "../lib/protocol";
import { createPlugin } from "../server";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  frames(): ClientMessage[] {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as ClientMessage);
  }
}

const SECRET_TITLE = "Rotate the production DB password";
const SECRET_PATH = "/Users/alice/work/acme";

const thread = (over: Record<string, unknown> = {}) =>
  makeThreadResponse({
    id: "thr_1",
    projectId: "proj_1",
    providerId: "claude-code",
    status: "idle",
    title: SECRET_TITLE,
    titleFallback: SECRET_PATH,
    ...over,
  } as never);

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function boot(opts: { room?: string; fetch?: typeof fetch; threads?: unknown[]; now?: () => number } = {}) {
  FakeSocket.all = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "friends",
    sdk: {
      projects: { list: async () => [{ id: "proj_1", name: "bb-friends" }] },
      threads: { list: async () => opts.threads ?? [] },
    },
  } as never);
  if (opts.room) await bb.storage.kv.set("room", opts.room);
  await createPlugin({
    createSocket: (url) => new FakeSocket(url),
    fetch: opts.fetch,
    now: opts.now,
  })(bb);
  const service = harness.behavior.runService("friends");
  await vi.advanceTimersByTimeAsync(10);
  return { bb, harness, service };
}

const welcome = (you = "me") => ({ t: "welcome", v: 1, you, members: [], feed: [] });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("plugin server", () => {
  it("connects to the saved room and says hello with a status-only payload", async () => {
    const { service } = await boot({ room: "ABCDEFGHJK", threads: [thread({ status: "active" })] });
    const socket = FakeSocket.all[0]!;
    expect(socket.url).toBe("ws://localhost:8787/rooms/ABCDEFGHJK/ws");
    socket.open();
    const [hello] = socket.frames();
    expect(hello).toMatchObject({
      t: "hello",
      status: { state: "busy", project: "bb-friends", threads: 1, provider: "claude-code" },
    });
    service.controller.abort();
    await service.done;
  });

  it("creates a random default avatar and preserves the chosen look across rename and restart", async () => {
    const { bb, harness, service } = await boot({ room: "ABCDEFGHJK" });
    const restartWithAvatar = async (saved: Avatar | undefined) => {
      const restarted = createFakePluginHost({ pluginId: "friends" });
      await restarted.bb.storage.kv.set("avatar", saved);
      await createPlugin({ createSocket: (url) => new FakeSocket(url) })(restarted.bb);
      return restarted.harness.behavior.callRpc("state", null);
    };
    const initial = await bb.storage.kv.get<Avatar>("avatar");
    expect(initial).toEqual({ style: "fun-emoji", seed: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(await restartWithAvatar(initial)).toMatchObject({ avatar: initial });
    const socket = FakeSocket.all[0]!;
    socket.open();
    expect(socket.frames()[0]).toMatchObject({ t: "hello", avatar: initial });
    socket.receive(welcome());

    const styled = await harness.behavior.callRpc("setAvatar", { style: "bottts" });
    expect(styled).toEqual({ ...initial, style: "bottts" });
    const rerolled = await harness.behavior.callRpc("setAvatar", null);
    expect(rerolled).toEqual({ style: "bottts", seed: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(rerolled).not.toEqual(styled);
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.frames().at(-1)).toMatchObject({ t: "status", avatar: rerolled });

    await harness.behavior.callRpc("setName", { name: "Ada" });
    const renamed = FakeSocket.all.at(-1)!;
    renamed.open();
    expect(renamed.frames()[0]).toMatchObject({ t: "hello", name: "Ada", avatar: rerolled });
    expect(await bb.storage.kv.get("avatar")).toEqual(rerolled);

    service.controller.abort();
    await service.done;

    // A fresh plugin instance reads the same persisted value.
    expect(await restartWithAvatar(await bb.storage.kv.get<Avatar>("avatar"))).toMatchObject({ avatar: rerolled });
  });

  it("never sends titles, paths or ids over the wire, whatever bb tells it", async () => {
    const { harness } = await boot({ room: "ABCDEFGHJK", threads: [thread({ status: "active" })] });
    const socket = FakeSocket.all[0]!;
    socket.open();
    socket.receive(welcome());
    await harness.behavior.emitThreadEvent("thread.active", { thread: thread({ id: "thr_2", status: "active" }) });
    await vi.advanceTimersByTimeAsync(500);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread({ id: "thr_2" }), lastAssistantText: "password is hunter2" });
    await vi.advanceTimersByTimeAsync(500);

    expect(socket.frames().length).toBeGreaterThanOrEqual(2); // hello + at least one status
    const wire = socket.sent.join("\n");
    for (const needle of [SECRET_TITLE, SECRET_PATH, "hunter2", "password", "thr_1", "thr_2", "proj_1"])
      expect(wire).not.toContain(needle);
    // Every frame we send is one of the three small status-shaped messages.
    for (const frame of socket.frames()) expect(["hello", "status", "done"]).toContain(frame.t);
  });

  it("pushes one debounced status when threads change", async () => {
    const { harness } = await boot({ room: "ABCDEFGHJK" });
    const socket = FakeSocket.all[0]!;
    socket.open();
    socket.receive(welcome());
    for (let i = 0; i < 5; i++)
      await harness.behavior.emitThreadEvent("thread.active", { thread: thread({ id: `t${i}`, status: "active" }) });
    await vi.advanceTimersByTimeAsync(500);
    const statuses = socket.frames().filter((f) => f.t === "status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ status: { state: "busy", threads: 5 } });
  });

  it("cheers only when a long run finishes", async () => {
    let clock = 1_000_000;
    const { harness } = await boot({ room: "ABCDEFGHJK", now: () => clock });
    const socket = FakeSocket.all[0]!;
    socket.open();
    socket.receive(welcome());

    await harness.behavior.emitThreadEvent("thread.active", { thread: thread({ status: "active" }) });
    clock += 10_000; // short run
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread(), lastAssistantText: null });
    expect(socket.frames().filter((f) => f.t === "done")).toHaveLength(0);

    await harness.behavior.emitThreadEvent("thread.active", { thread: thread({ status: "active" }) });
    clock += 3 * 60_000; // long run
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread(), lastAssistantText: null });
    expect(socket.frames().filter((f) => f.t === "done")).toHaveLength(1);
  });

  it("turns server pokes into realtime signals for the toaster", async () => {
    const { harness } = await boot({ room: "ABCDEFGHJK" });
    const socket = FakeSocket.all[0]!;
    socket.open();
    socket.receive(welcome());
    socket.receive({ t: "poke", from: { id: "a", name: "Ada" }, at: 5 });
    expect(harness.realtimeSignals).toContainEqual(
      expect.objectContaining({ channel: "friends-poke", payload: { fromName: "Ada", at: 5 } }),
    );
  });

  it("createRoom hits the server, saves the code and connects", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: "KMNPQRSTUV" }, 201));
    const { harness, bb } = await boot({ fetch: fetchMock as never });
    expect(FakeSocket.all).toHaveLength(0); // no room yet
    await expect(harness.behavior.callRpc("createRoom", null)).resolves.toEqual({ code: "KMNPQRSTUV" });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8787/rooms", expect.objectContaining({ method: "POST" }));
    expect(await bb.storage.kv.get("room")).toBe("KMNPQRSTUV");
    expect(FakeSocket.all[0]!.url).toBe("ws://localhost:8787/rooms/KMNPQRSTUV/ws");
  });

  it("joinRoom normalizes the code and refuses unknown or malformed ones", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      jsonResponse({ exists: url.endsWith("/KMNPQRSTUV") }),
    );
    const { harness } = await boot({ fetch: fetchMock as never });
    await expect(harness.behavior.callRpc("joinRoom", { code: "kmnpq-rstuv" })).resolves.toEqual({ code: "KMNPQRSTUV" });
    await expect(harness.behavior.callRpc("joinRoom", { code: "nope" })).rejects.toThrow(/invite code/);
    await expect(harness.behavior.callRpc("joinRoom", { code: "ABCDEFGHJK" })).rejects.toThrow(/No room/);
  });

  it("explains an unreachable server instead of crashing", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { harness } = await boot({ fetch: fetchMock as never });
    await expect(harness.behavior.callRpc("createRoom", null)).rejects.toThrow(/Can't reach the friends server/);
  });

  it("poke goes out over the socket, and refuses when offline", async () => {
    const { harness } = await boot({ room: "ABCDEFGHJK" });
    await expect(harness.behavior.callRpc("poke", { to: "abc" })).rejects.toThrow(/Not connected/);
    const socket = FakeSocket.all[0]!;
    socket.open();
    socket.receive(welcome());
    await expect(harness.behavior.callRpc("poke", { to: "abc" })).resolves.toEqual({ sent: true });
    expect(socket.frames().at(-1)).toEqual({ t: "poke", to: "abc" });
    await expect(harness.behavior.callRpc("react", { to: "abc", emoji: "💩" })).rejects.toThrow();
  });

  it("state reflects the live room; leaving forgets it", async () => {
    const { harness, bb } = await boot({ room: "ABCDEFGHJK" });
    const socket = FakeSocket.all[0]!;
    socket.open();
    socket.receive({
      t: "welcome",
      v: 1,
      you: "me",
      members: [{ id: "me", name: "Me", since: 1, status: { state: "idle", project: null, threads: 0, provider: null } }],
      feed: [],
    });
    expect(await harness.behavior.callRpc("state", null)).toMatchObject({
      room: "ABCDEFGHJK",
      connection: "connected",
      you: "me",
      members: [{ name: "Me" }],
    });
    await harness.behavior.callRpc("leaveRoom", null);
    expect(await bb.storage.kv.get("room")).toBeUndefined();
    expect(await harness.behavior.callRpc("state", null)).toMatchObject({ room: null, connection: "disconnected" });
  });
});
