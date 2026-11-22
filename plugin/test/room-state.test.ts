import { describe, expect, it } from "vitest";

import { describeFeed, describeStatus, sortMembers } from "../lib/describe";
import type { Member } from "../lib/protocol";
import { applyServerMessage, emptyView } from "../lib/room-state";

const member = (id: string, name: string, state: Member["status"]["state"] = "idle"): Member => ({
  id,
  name,
  since: 1,
  status: { state, project: null, threads: 0, provider: null },
});

describe("applyServerMessage", () => {
  it("builds the room from welcome, then applies deltas", () => {
    let view = applyServerMessage(emptyView("connecting"), {
      t: "welcome",
      v: 1,
      you: "me",
      members: [member("me", "Me")],
      feed: [],
    });
    expect(view).toMatchObject({ connection: "connected", you: "me" });

    view = applyServerMessage(view, { t: "member", member: member("a", "Ada") });
    expect(view.members.map((m) => m.name)).toEqual(["Me", "Ada"]);

    view = applyServerMessage(view, { t: "member", member: member("a", "Ada", "busy") });
    expect(view.members).toHaveLength(2);
    expect(view.members.find((m) => m.id === "a")?.status.state).toBe("busy");

    view = applyServerMessage(view, { t: "left", id: "a" });
    expect(view.members.map((m) => m.id)).toEqual(["me"]);
  });

  it("bounds the feed to the ring-buffer size and dedupes by id", () => {
    let view = emptyView("connected");
    for (let id = 1; id <= 80; id++)
      view = applyServerMessage(view, {
        t: "feed",
        entry: { id, at: id, kind: "busy", who: "A", whoId: "a" },
      });
    view = applyServerMessage(view, { t: "feed", entry: { id: 80, at: 80, kind: "busy", who: "A", whoId: "a" } });
    expect(view.feed).toHaveLength(50);
    expect(view.feed.at(-1)?.id).toBe(80);
  });

  it("treats pokes and reactions as events, not state", () => {
    const view = emptyView("connected");
    expect(applyServerMessage(view, { t: "poke", from: { id: "a", name: "A" }, at: 1 })).toBe(view);
  });
});

describe("describe helpers", () => {
  it("sorts busy first and describes status from status fields only", () => {
    expect(sortMembers([member("1", "Zed", "online"), member("2", "Ann", "busy"), member("3", "Bob", "idle")]).map((m) => m.name)).toEqual([
      "Ann",
      "Bob",
      "Zed",
    ]);
    expect(describeStatus({ state: "busy", project: "bb", threads: 2, provider: "codex" })).toBe(
      "Working in bb · 2 threads · codex",
    );
    expect(describeStatus({ state: "busy", project: null, threads: 1, provider: null })).toBe("Working · 1 thread");
    expect(describeFeed({ id: 1, at: 1, kind: "poke", who: "Ada", whoId: "a", target: "Bo", targetId: "b" })).toBe("Ada poked Bo");
  });
});
