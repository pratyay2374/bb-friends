import { describe, expect, it } from "vitest";

import { deriveStatus, type ThreadFacts } from "../lib/status";
import { ThreadTracker } from "../lib/tracker";

const thread = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({
  id: "thr_1",
  status: "idle",
  projectId: "proj_1",
  providerId: "claude-code",
  updatedAt: 100,
  archivedAt: null,
  deletedAt: null,
  visibility: "visible",
  parentThreadId: null,
  ...over,
});
const names = new Map([
  ["proj_1", "bb-friends"],
  ["proj_2", "api"],
]);
const opts = { projectNames: names, shareDetails: true };

describe("deriveStatus", () => {
  it("is online with no threads, idle with threads at rest, busy when one runs", () => {
    expect(deriveStatus([], opts)).toEqual({ state: "online", project: null, threads: 0, provider: null });
    expect(deriveStatus([thread()], opts)).toMatchObject({ state: "idle", project: "bb-friends", threads: 0 });
    expect(deriveStatus([thread({ status: "active" }), thread({ id: "t2", status: "starting" })], opts)).toMatchObject({
      state: "busy",
      threads: 2,
    });
  });

  it("focuses on the most recently updated running thread", () => {
    const status = deriveStatus(
      [
        thread({ id: "a", status: "active", projectId: "proj_1", updatedAt: 10 }),
        thread({ id: "b", status: "active", projectId: "proj_2", providerId: "codex", updatedAt: 20 }),
        thread({ id: "c", status: "idle", projectId: "proj_1", updatedAt: 99 }),
      ],
      opts,
    );
    expect(status).toEqual({ state: "busy", project: "api", threads: 2, provider: "codex" });
  });

  it("ignores archived, deleted and hidden threads", () => {
    const status = deriveStatus(
      [
        thread({ id: "a", status: "active", archivedAt: 5 }),
        thread({ id: "b", status: "active", deletedAt: 5 }),
        thread({ id: "c", status: "active", visibility: "hidden" }),
      ],
      opts,
    );
    expect(status.state).toBe("online");
    expect(status.threads).toBe(0);
  });

  it("withholds project and provider when details sharing is off", () => {
    expect(deriveStatus([thread({ status: "active" })], { ...opts, shareDetails: false })).toEqual({
      state: "busy",
      project: null,
      threads: 1,
      provider: null,
    });
  });

  it("never reports a project it has no name for (no id leakage)", () => {
    expect(deriveStatus([thread({ projectId: "proj_unknown" })], opts).project).toBeNull();
  });

  it("caps the thread count", () => {
    const many = Array.from({ length: 1500 }, (_, i) => thread({ id: `t${i}`, status: "active" }));
    expect(deriveStatus(many, opts).threads).toBe(999);
  });

  it("NEVER leaks thread titles, prompts, paths or environment details", () => {
    // A realistic full DTO: the extra fields below are what must not escape.
    const secret = {
      ...thread({ status: "active" }),
      title: "Fix payroll bug for ACME",
      titleFallback: "Prompt: rotate the prod DB password",
      environmentId: "env_secret",
      path: "/Users/alice/work/acme/payroll",
      lastAssistantText: "the password is hunter2",
      pluginMetadata: { note: "internal only" },
    };
    const status = deriveStatus([secret], opts);
    expect(Object.keys(status).sort()).toEqual(["project", "provider", "state", "threads"]);
    const wire = JSON.stringify(status);
    for (const needle of ["payroll", "ACME", "password", "hunter2", "/Users", "env_secret", "internal", "thr_1", "proj_1"])
      expect(wire).not.toContain(needle);
  });

  it("the tracker keeps only whitelisted fields in memory", () => {
    const tracker = new ThreadTracker();
    tracker.upsert({ ...thread(), title: "SECRET TITLE", path: "/secret" } as ThreadFacts);
    const kept = JSON.stringify(tracker.facts());
    expect(kept).not.toContain("SECRET");
    expect(kept).not.toContain("/secret");
  });
});

describe("ThreadTracker", () => {
  it("measures how long a thread ran", () => {
    const tracker = new ThreadTracker();
    tracker.markActive("a", 1_000);
    tracker.markActive("a", 5_000); // restarts of the same run keep the first start
    expect(tracker.finish("a", 61_000)).toBe(60_000);
    expect(tracker.finish("a", 62_000)).toBeNull();
  });
});
