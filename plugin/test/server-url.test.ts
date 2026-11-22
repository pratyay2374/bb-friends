import { describe, expect, it } from "vitest";

import { parseServerUrl, roomSocketUrl, roomUrl, roomsUrl } from "../lib/server-url";

describe("server urls", () => {
  it("builds http and ws urls for a bare origin, with or without a trailing slash", () => {
    for (const input of ["http://localhost:8787", "http://localhost:8787/", " http://localhost:8787 "]) {
      const base = parseServerUrl(input)!;
      expect(roomsUrl(base)).toBe("http://localhost:8787/rooms");
      expect(roomUrl(base, "ABCDEFGHJK")).toBe("http://localhost:8787/rooms/ABCDEFGHJK");
      expect(roomSocketUrl(base, "ABCDEFGHJK")).toBe("ws://localhost:8787/rooms/ABCDEFGHJK/ws");
    }
  });

  it("uses wss for https and keeps a path prefix", () => {
    const base = parseServerUrl("https://friends.example.workers.dev/v1/?x=1#y")!;
    expect(roomsUrl(base)).toBe("https://friends.example.workers.dev/v1/rooms");
    expect(roomSocketUrl(base, "ABCDEFGHJK")).toBe("wss://friends.example.workers.dev/v1/rooms/ABCDEFGHJK/ws");
  });

  it("rejects non-http schemes and junk", () => {
    expect(parseServerUrl("ftp://x")).toBeNull();
    expect(parseServerUrl("javascript:alert(1)")).toBeNull();
    expect(parseServerUrl("not a url")).toBeNull();
  });
});
