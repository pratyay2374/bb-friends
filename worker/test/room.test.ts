import { SELF, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CLOSE, LIMITS } from "../src/protocol";
import { Client, createRoom, status } from "./helpers";

const stubFor = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));

describe("worker routing", () => {
  it("creates unguessable rooms and reports existence", async () => {
    const code = await createRoom();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    const yes = await SELF.fetch(`http://edge/rooms/${code}`);
    expect(await yes.json()).toEqual({ exists: true });
    const no = await SELF.fetch("http://edge/rooms/ZZZZZZZZZZ");
    expect(await no.json()).toEqual({ exists: false });
  });

  it("refuses sockets to rooms nobody created (codes can't be chosen)", async () => {
    const res = await SELF.fetch("http://edge/rooms/ABCDEFGHJK/ws", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });

  it("validates codes and methods", async () => {
    expect((await SELF.fetch("http://edge/rooms/short/ws")).status).toBe(400);
    expect((await SELF.fetch("http://edge/rooms")).status).toBe(405);
    expect((await SELF.fetch("http://edge/nope")).status).toBe(404);
    const code = await createRoom();
    expect((await SELF.fetch(`http://edge/rooms/${code}/ws`)).status).toBe(426);
  });
});

describe("presence", () => {
  it("two clients see each other, by welcome and by delta", async () => {
    const code = await createRoom();
    const a = await Client.join(code, "Ada", { status: status({ project: "bb", provider: "claude-code" }) });
    const b = await Client.join(code, "Bo");

    expect(b.welcome.members.map((m) => m.name).sort()).toEqual(["Ada", "Bo"]);
    expect(b.welcome.members.find((m) => m.name === "Ada")?.status).toEqual(
      status({ project: "bb", provider: "claude-code" }),
    );
    const joined = await a.client.next((m) => m.t === "member" && m.member.name === "Bo");
    expect(joined).toMatchObject({ t: "member" });
    await a.client.next((m) => m.t === "feed" && m.entry.kind === "joined" && m.entry.who === "Bo");
  });

  it("broadcasts status as a delta only when something changed", async () => {
    const code = await createRoom();
    const a = await Client.join(code, "Ada");
    const b = await Client.join(code, "Bo");
    await a.client.next((m) => m.t === "member");
    const before = b.client.frames.length;

    a.client.send({ t: "status", status: status({ state: "busy", threads: 2, project: "bb" }) });
    const delta = await b.client.next((m) => m.t === "member" && m.member.status.state === "busy");
    expect(delta).toMatchObject({ member: { id: a.id, status: { threads: 2, project: "bb" } } });
    const feed = await b.client.next((m) => m.t === "feed" && m.entry.kind === "busy");
    expect(feed).toMatchObject({ entry: { who: "Ada" } });

    // identical status again: no frames at all
    const count = b.client.frames.length;
    a.client.send({ t: "status", status: status({ state: "busy", threads: 2, project: "bb" }) });
    await b.client.quiet();
    expect(b.client.frames.length).toBe(count);
    expect(count).toBeGreaterThan(before);

    // thread count moves but state stays busy: delta, no new feed entry
    a.client.send({ t: "status", status: status({ state: "busy", threads: 3, project: "bb" }) });
    await b.client.next((m) => m.t === "member" && m.member.status.threads === 3);
    expect(b.client.of("feed").filter((f) => f.entry.kind === "busy")).toHaveLength(1);
  });

  it("announces a member leaving", async () => {
    const code = await createRoom();
    const a = await Client.join(code, "Ada");
    const b = await Client.join(code, "Bo");
    b.client.ws.close(1000, "bye");
    expect(await a.client.next("left")).toMatchObject({ id: b.id });
    await a.client.next((m) => m.t === "feed" && m.entry.kind === "left");
  });

  it("survives hibernation: presence and feed are rebuilt from sockets + storage", async () => {
    const code = await createRoom();
    const a = await Client.join(code, "Ada");
    const b = await Client.join(code, "Bo", { status: status({ state: "busy", threads: 1 }) });
    await a.client.next((m) => m.t === "member");

    await evictDurableObject(stubFor(code)); // drops all in-memory state

    // Both sockets still work after the wake-up...
    a.client.send({ t: "poke", to: b.id });
    expect(await b.client.next("poke")).toMatchObject({ from: { id: a.id, name: "Ada" } });

    // ...and a newcomer sees the pre-eviction state.
    const c = await Client.join(code, "Cy");
    expect(c.welcome.members.map((m) => m.name).sort()).toEqual(["Ada", "Bo", "Cy"]);
    expect(c.welcome.members.find((m) => m.name === "Bo")?.status.state).toBe("busy");
    expect(c.welcome.feed.some((f) => f.kind === "joined" && f.who === "Ada")).toBe(true);
  });

  it("treats a reconnect from the same install as one continuous member", async () => {
    const code = await createRoom();
    const watcher = await Client.join(code, "Watcher");
    const first = await Client.join(code, "Ada", { cid: "c".repeat(24) });
    await watcher.client.next((m) => m.t === "member" && m.member.name === "Ada");
    const second = await Client.join(code, "Ada", { cid: "c".repeat(24) });

    expect(second.id).toBe(first.id); // identity is preserved
    await first.client.quiet();
    expect(first.client.closed?.code).toBe(CLOSE.replaced);
    const joins = watcher.client.of("feed").filter((f) => f.entry.kind === "joined" && f.entry.who === "Ada");
    expect(joins).toHaveLength(1);
    expect(watcher.client.of("left")).toHaveLength(0);
  });

  it("caps the room size", async () => {
    const code = await createRoom();
    for (let i = 0; i < LIMITS.maxMembers; i++) await Client.join(code, `m${i}`);
    const extra = await Client.open(code);
    extra.send({ t: "hello", v: 1, cid: "z".repeat(20), name: "late" });
    expect(await extra.next("error")).toMatchObject({ code: "room_full" });
    await extra.quiet();
    expect(extra.closed?.code).toBe(CLOSE.roomFull);
  });
});

describe("pokes and reactions", () => {
  it("delivers a poke to the target only, and records it in the feed", async () => {
    const code = await createRoom();
    const a = await Client.join(code, "Ada");
    const b = await Client.join(code, "Bo");
    const c = await Client.join(code, "Cy");

    a.client.send({ t: "poke", to: b.id });
    expect(await b.client.next("poke")).toMatchObject({ from: { id: a.id, name: "Ada" } });
    const entry = await c.client.next((m) => m.t === "feed" && m.entry.kind === "poke");
    expect(entry).toMatchObject({ entry: { who: "Ada", target: "Bo" } });
    await c.client.quiet();
    expect(c.client.of("poke")).toHaveLength(0);
    expect(a.client.of("poke")).toHaveLength(0);
  });

  it("rate-limits pokes per sender, even across reconnects", async () => {
    const code = await createRoom();
    const cid = "r".repeat(24);
    const a = await Client.join(code, "Ada", { cid });
    const b = await Client.join(code, "Bo");

    for (let i = 0; i < 6; i++) a.client.send({ t: "poke", to: b.id });
    await b.client.quiet(150);
    expect(b.client.of("poke")).toHaveLength(6);

    a.client.send({ t: "poke", to: b.id });
    expect(await a.client.next("error")).toMatchObject({ code: "rate_limited" });

    // A fresh connection with the same client id does not reset the budget.
    const again = await Client.join(code, "Ada", { cid });
    again.client.send({ t: "poke", to: b.id });
    expect(await again.client.next("error")).toMatchObject({ code: "rate_limited" });
    expect(b.client.of("poke")).toHaveLength(6);
  });

  it("rejects self-pokes and unknown targets", async () => {
    const code = await createRoom();
    const a = await Client.join(code, "Ada");
    a.client.send({ t: "poke", to: a.id });
    expect(await a.client.next("error")).toMatchObject({ code: "self_target" });
    a.client.send({ t: "poke", to: "nobody" });
    expect(await a.client.next((m) => m.t === "error" && m.code === "unknown_member")).toBeTruthy();
  });

  it("delivers reactions and 'done' updates", async () => {
    const code = await createRoom();
    const a = await Client.join(code, "Ada");
    const b = await Client.join(code, "Bo");
    a.client.send({ t: "done" });
    await b.client.next((m) => m.t === "feed" && m.entry.kind === "done" && m.entry.who === "Ada");
    b.client.send({ t: "react", to: a.id, emoji: "🙌" });
    expect(await a.client.next("react")).toMatchObject({ emoji: "🙌", from: { name: "Bo" } });
  });
});

describe("hardening", () => {
  it("rejects messages before hello", async () => {
    const code = await createRoom();
    const c = await Client.open(code);
    c.send({ t: "poke", to: "x" });
    expect(await c.next("error")).toMatchObject({ code: "not_joined" });
    await c.quiet();
    expect(c.closed?.code).toBe(CLOSE.badHello);
  });

  it("rejects a second hello, malformed JSON, and oversized frames", async () => {
    const code = await createRoom();
    const { client } = await Client.join(code, "Ada");
    client.send({ t: "hello", v: 1, cid: "q".repeat(20), name: "again" });
    expect(await client.next("error")).toMatchObject({ code: "already_joined" });
    client.send("{{{");
    expect(await client.next((m) => m.t === "error" && m.code === "bad_message")).toBeTruthy();
    client.send(JSON.stringify({ t: "done", pad: "x".repeat(2000) }));
    expect(await client.next((m) => m.t === "error" && m.code === "too_large")).toBeTruthy();
    await client.quiet();
    expect(client.closed?.code).toBe(CLOSE.badHello);
  });

  it("answers keepalive pings without involving the room logic", async () => {
    const code = await createRoom();
    const res = await SELF.fetch(`http://edge/rooms/${code}/ws`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    const pong = new Promise<string>((resolve) =>
      ws.addEventListener("message", (e) => resolve(e.data as string)),
    );
    ws.accept();
    ws.send("ping");
    expect(await pong).toBe("pong");
  });

  it("closes sockets that never say hello, but not ones that did", async () => {
    const code = await createRoom();
    const lurker = await Client.open(code);
    const member = await Client.join(code, "Ada");
    // Pretend the lurker connected long ago.
    await runInDurableObject(stubFor(code), (_room, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { pendingSince?: number } | null;
        if (att && "pendingSince" in att) ws.serializeAttachment({ pendingSince: 1 });
      }
    });
    await runDurableObjectAlarm(stubFor(code));
    await lurker.quiet();
    expect(lurker.closed?.code).toBe(CLOSE.helloTimeout);
    expect(member.client.closed).toBeNull();
  });

  it("keeps only the newest feed entries", async () => {
    const code = await createRoom();
    const a = await Client.join(code, "Ada");
    // 6 'done' per minute is the limit, so flip busy/idle to generate entries.
    for (let i = 0; i < LIMITS.feedSize + 10; i++) {
      a.client.send({ t: "status", status: status({ state: i % 2 ? "idle" : "busy", threads: i % 2 }) });
      if (i % 15 === 14) await a.client.quiet(30); // stay under the status flood limit
    }
    await a.client.quiet(100);
    const late = await Client.join(code, "Late");
    expect(late.welcome.feed.length).toBeLessThanOrEqual(LIMITS.feedSize);
  });
});

describe("room lifecycle", () => {
  it("forgets an empty room once its TTL alarm fires", async () => {
    const code = await createRoom();
    const a = await Client.join(code, "Ada");
    a.client.ws.close(1000, "bye");
    await a.client.quiet(100);
    expect(await runDurableObjectAlarm(stubFor(code))).toBe(true);
    const res = await SELF.fetch(`http://edge/rooms/${code}`);
    expect(await res.json()).toEqual({ exists: false });
  });
});
