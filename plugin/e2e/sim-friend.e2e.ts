import { describe, it } from "vitest";

import { FriendsConnection, type SocketLike } from "../lib/connection";
import { applyServerMessage, emptyView, type RoomView } from "../lib/room-state";
import { parseServerUrl, roomSocketUrl } from "../lib/server-url";

/**
 * Manual helper, skipped unless FRIEND_ROOM is set: joins a live room as a
 * friend, pokes/reacts/cheers at the given delays, then leaves. Used to see a
 * real bb react to a friend (toast, list, feed) with only one bb available.
 *
 *   FRIEND_ROOM=ABCDE12345 FRIEND_SECONDS=120 npx vitest run --config vitest.e2e.config.ts sim-friend
 */
const room = process.env.FRIEND_ROOM;
const base = parseServerUrl(process.env.FRIENDS_URL ?? "http://localhost:8787")!;
const seconds = Number(process.env.FRIEND_SECONDS ?? 90);

describe.skipIf(!room)("simulated friend", () => {
  it("joins, pokes, reacts, cheers, leaves", async () => {
    let view: RoomView = emptyView();
    const log = (m: string) => console.log(`[friend ${new Date().toISOString().slice(11, 19)}] ${m}`);
    const connection = new FriendsConnection({
      url: roomSocketUrl(base, room!),
      cid: crypto.randomUUID().replaceAll("-", ""),
      name: "Bo (sim)",
      getStatus: () => ({ state: "busy", project: "api-gateway", threads: 3, provider: "codex" }),
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      onMessage: (m) => {
        view = applyServerMessage(view, m);
        if (m.t === "poke" || m.t === "react") log(`received ${JSON.stringify(m)}`);
      },
      onState: (s) => log(`connection ${s}`),
      onFatal: (r) => log(`fatal ${r}`),
    });
    connection.start();
    const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
    const other = () => view.members.find((m) => m.id !== view.you)?.id;
    await wait(Number(process.env.FRIEND_POKE_AT ?? 15));
    const target = other();
    if (target) {
      log("poking");
      connection.send({ t: "poke", to: target });
      await wait(5);
      log("reacting 🎉");
      connection.send({ t: "react", to: target, emoji: "🎉" });
      await wait(5);
      log("done (thread finished)");
      connection.send({ t: "done" });
    } else log("nobody else in the room");
    await wait(seconds);
    connection.stop();
  }, (seconds + 120) * 1000);
});
