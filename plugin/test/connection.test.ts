import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FriendsConnection, type SocketLike } from "../lib/connection";
import { CLOSE, type ServerMessage, type Status } from "../lib/protocol";
import type { ConnectionState } from "../lib/room-state";

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
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

const status: Status = { state: "busy", project: "bb", threads: 1, provider: "codex" };

function make() {
  const states: ConnectionState[] = [];
  const messages: ServerMessage[] = [];
  const fatal: string[] = [];
  const connection = new FriendsConnection({
    url: "ws://x/rooms/ABCDEFGHJK/ws",
    cid: "c".repeat(20),
    name: "Ada",
    getStatus: () => status,
    createSocket: (url) => new FakeSocket(url),
    onMessage: (m) => messages.push(m),
    onState: (s) => states.push(s),
    onFatal: (r) => fatal.push(r),
    random: () => 1, // no jitter shrink
  });
  return { connection, states, messages, fatal };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

describe("FriendsConnection", () => {
  it("says hello with the current status when the socket opens, and goes connected on welcome", () => {
    const { connection, states, messages } = make();
    connection.start();
    const socket = FakeSocket.all[0]!;
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      t: "hello",
      v: 1,
      cid: "c".repeat(20),
      name: "Ada",
      status,
    });
    socket.receive({ t: "welcome", v: 1, you: "me", members: [], feed: [] });
    expect(states).toEqual(["connecting", "connected"]);
    expect(messages).toHaveLength(1);
  });

  it("ignores pongs and non-JSON frames", () => {
    const { connection, messages } = make();
    connection.start();
    const socket = FakeSocket.all[0]!;
    socket.open();
    socket.receive("pong");
    socket.receive("{{not json");
    expect(messages).toHaveLength(0);
  });

  it("sends keepalive pings and reconnects with growing backoff after a drop", () => {
    const { connection } = make();
    connection.start();
    const first = FakeSocket.all[0]!;
    first.open();
    vi.advanceTimersByTime(25_000);
    expect(first.sent).toContain("ping");

    first.onclose?.({ code: 1006, reason: "" });
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);

    FakeSocket.all[1]!.onclose?.({ code: 1006, reason: "" }); // second failure waits longer
    vi.advanceTimersByTime(1_999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("resets the backoff after a successful welcome", () => {
    const { connection } = make();
    connection.start();
    FakeSocket.all[0]!.onclose?.({ code: 1006, reason: "" });
    vi.advanceTimersByTime(1_000);
    const second = FakeSocket.all[1]!;
    second.open();
    second.receive({ t: "welcome", v: 1, you: "me", members: [], feed: [] });
    second.onclose?.({ code: 1006, reason: "" });
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("drops a connection that goes silent", () => {
    const { connection } = make();
    connection.start();
    const socket = FakeSocket.all[0]!;
    socket.open();
    vi.advanceTimersByTime(70_000);
    expect(socket.readyState).toBe(3);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it.each([
    [CLOSE.roomFull, "full"],
    [CLOSE.badHello, "rejected"],
    [CLOSE.replaced, "took over"],
  ])("stops for good on close code %i", (code, text) => {
    const { connection, fatal, states } = make();
    connection.start();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.onclose?.({ code, reason: "" });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(fatal[0]).toContain(text);
    expect(states.at(-1)).toBe("disconnected");
  });

  it("stop() closes quietly and never reconnects; send() only works when open", () => {
    const { connection } = make();
    expect(connection.send({ t: "done" })).toBe(false);
    connection.start();
    const socket = FakeSocket.all[0]!;
    expect(connection.send({ t: "done" })).toBe(false); // still connecting
    socket.open();
    expect(connection.send({ t: "done" })).toBe(true);
    connection.stop();
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
