import { describe, expect, it } from "vitest";

import { FriendsConnection, type SocketLike } from "../lib/connection";
import type { ClientMessage, ServerMessage, Status } from "../lib/protocol";
import { applyServerMessage, emptyView, type RoomView } from "../lib/room-state";
import { parseServerUrl, roomSocketUrl, roomUrl, roomsUrl } from "../lib/server-url";

const BASE = parseServerUrl(process.env.FRIENDS_URL ?? "http://localhost:8787")!;

/** A simulated bb install: the plugin's own connection + reducer, no bb needed. */
function simulate(name: string, status: Status) {
  let view: RoomView = emptyView();
  const events: ServerMessage[] = [];
  const waiters: { pred: () => boolean; resolve: () => void }[] = [];
  const settle = () => {
    for (const w of [...waiters]) if (w.pred()) (waiters.splice(waiters.indexOf(w), 1), w.resolve());
  };
  let connection: FriendsConnection;
  return {
    name,
    get view() {
      return view;
    },
    events,
    connect(code: string) {
      connection = new FriendsConnection({
        url: roomSocketUrl(BASE, code),
        cid: crypto.randomUUID().replaceAll("-", ""),
        name,
        getStatus: () => status,
        createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
        onMessage: (m) => {
          events.push(m);
          view = applyServerMessage(view, m);
          settle();
        },
        onState: (connectionState) => {
          view = { ...view, connection: connectionState };
          settle();
        },
        onFatal: (reason) => {
          throw new Error(reason);
        },
      });
      connection.start();
    },
    send: (m: ClientMessage) => connection.send(m),
    stop: () => connection.stop(),
    until(pred: () => boolean, label: string, ms = 8000) {
      if (pred()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), ms);
        waiters.push({ pred, resolve: () => (clearTimeout(timer), resolve()) });
      });
    },
  };
}

describe("two clients through a real `wrangler dev`", () => {
  it("see each other's presence, status changes, a poke and a reaction", async () => {
    const created = await fetch(roomsUrl(BASE), { method: "POST" });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(((await (await fetch(roomUrl(BASE, code))).json()) as { exists: boolean }).exists).toBe(true);

    const ada = simulate("Ada", { state: "busy", project: "bb-friends", threads: 2, provider: "claude-code" });
    const bo = simulate("Bo", { state: "idle", project: "api", threads: 0, provider: "codex" });

    ada.connect(code);
    await ada.until(() => ada.view.connection === "connected", "Ada connected");
    bo.connect(code);
    await bo.until(() => bo.view.connection === "connected", "Bo connected");

    // 1. presence, both ways
    await ada.until(() => ada.view.members.some((m) => m.name === "Bo"), "Ada sees Bo");
    await bo.until(() => bo.view.members.some((m) => m.name === "Ada"), "Bo sees Ada");
    const adaAsBoSeesHer = bo.view.members.find((m) => m.name === "Ada")!;
    expect(adaAsBoSeesHer.status).toEqual({ state: "busy", project: "bb-friends", threads: 2, provider: "claude-code" });
    expect(ada.view.members.find((m) => m.name === "Bo")!.status.state).toBe("idle");
    console.log("presence  Ada sees:", ada.view.members.map((m) => `${m.name}(${m.status.state})`).join(", "));
    console.log("presence  Bo  sees:", bo.view.members.map((m) => `${m.name}(${m.status.state})`).join(", "));

    // 2. status delta
    ada.send({ t: "status", status: { state: "idle", project: "bb-friends", threads: 0, provider: "claude-code" } });
    await bo.until(() => bo.view.members.find((m) => m.name === "Ada")?.status.state === "idle", "Bo sees Ada go idle");
    console.log("delta     Bo sees Ada ->", bo.view.members.find((m) => m.name === "Ada")!.status.state);

    // 3. poke Ada -> Bo, delivered to Bo only
    ada.send({ t: "poke", to: bo.view.you! });
    await bo.until(() => bo.events.some((m) => m.t === "poke"), "Bo gets the poke");
    const poke = bo.events.find((m) => m.t === "poke");
    expect(poke).toMatchObject({ t: "poke", from: { name: "Ada", id: ada.view.you } });
    console.log("poke      Bo received:", JSON.stringify(poke));
    await ada.until(() => ada.view.feed.some((e) => e.kind === "poke" && e.target === "Bo"), "poke in Ada's feed");
    expect(ada.events.some((m) => m.t === "poke")).toBe(false);

    // 4. reaction back
    bo.send({ t: "react", to: ada.view.you!, emoji: "🙌" });
    await ada.until(() => ada.events.some((m) => m.t === "react"), "Ada gets the reaction");
    console.log("react     Ada received:", JSON.stringify(ada.events.find((m) => m.t === "react")));

    // 5. leaving
    bo.stop();
    await ada.until(() => !ada.view.members.some((m) => m.name === "Bo"), "Ada sees Bo leave");
    console.log("leave     Ada sees:", ada.view.members.map((m) => m.name).join(", "));
    console.log("feed      ", ada.view.feed.map((e) => `${e.kind}:${e.who}${e.target ? `->${e.target}` : ""}`).join(" | "));
    ada.stop();
  });
});
