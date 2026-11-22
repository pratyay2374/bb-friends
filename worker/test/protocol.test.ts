import { describe, expect, it } from "vitest";

import {
  LIMITS,
  PROTOCOL_VERSION,
  cleanText,
  formatRoomCode,
  generateRoomCode,
  normalizeRoomCode,
  parseClientMessage,
} from "../src/protocol";

const hello = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, cid: "a".repeat(20), name: "Ada", ...over });

describe("room codes", () => {
  it("are 10 chars from an unambiguous alphabet and not repeated", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(500);
  });

  it("normalizes user input and rejects junk", () => {
    expect(normalizeRoomCode(" abcde-fghjk ")).toBe("ABCDEFGHJK");
    expect(normalizeRoomCode("ABC")).toBeNull(); // too short
    expect(normalizeRoomCode("ABCDEFGH0I")).toBeNull(); // 0 and I are not in the alphabet
    expect(normalizeRoomCode("../../etc/passwd")).toBeNull();
    expect(formatRoomCode("ABCDEFGHJK")).toBe("ABCDE-FGHJK");
  });
});

describe("parseClientMessage", () => {
  it("accepts a valid hello and sanitizes the name", () => {
    const parsed = parseClientMessage(hello({ name: "  Ada\u0000‮  Lovelace  " }));
    expect(parsed).toMatchObject({ ok: true, value: { t: "hello", name: "Ada Lovelace" } });
  });

  it("truncates over-long names rather than storing them", () => {
    const parsed = parseClientMessage(hello({ name: "x".repeat(200) }));
    expect(parsed.ok && parsed.value.t === "hello" && parsed.value.name.length).toBe(LIMITS.nameMax);
  });

  it.each([
    ["not json", "{nope"],
    ["array", "[]"],
    ["no type", "{}"],
    ["unknown type", JSON.stringify({ t: "rm -rf" })],
    ["empty name", hello({ name: "   " })],
    ["short cid", hello({ cid: "short" })],
    ["cid with bad chars", hello({ cid: "a/".repeat(12) })],
    ["bad version", hello({ v: 99 })],
    ["bad state", JSON.stringify({ t: "status", status: { state: "afk", project: null, threads: 0, provider: null } })],
    ["fractional threads", JSON.stringify({ t: "status", status: { state: "busy", project: null, threads: 1.5, provider: null } })],
    ["too many threads", JSON.stringify({ t: "status", status: { state: "busy", project: null, threads: 1000, provider: null } })],
    ["numeric project", JSON.stringify({ t: "status", status: { state: "busy", project: 3, threads: 0, provider: null } })],
    ["disallowed emoji", JSON.stringify({ t: "react", to: "abc", emoji: "💩" })],
    ["react without target", JSON.stringify({ t: "react", emoji: "👍" })],
    ["poke with object target", JSON.stringify({ t: "poke", to: { id: 1 } })],
  ])("rejects %s", (_label, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it("rejects frames over the byte cap (string and binary)", () => {
    const big = hello({ name: "Ada", pad: "x".repeat(LIMITS.maxMessageBytes) });
    expect(parseClientMessage(big)).toMatchObject({ ok: false, code: "too_large" });
    expect(parseClientMessage(new TextEncoder().encode(big).buffer as ArrayBuffer)).toMatchObject({
      ok: false,
      code: "too_large",
    });
  });

  it("counts bytes, not characters", () => {
    // 600 emoji = 600 chars but ~2400 bytes
    const raw = JSON.stringify({ t: "hello", v: 1, cid: "a".repeat(20), name: "😀".repeat(600) });
    expect(raw.length).toBeLessThan(LIMITS.maxMessageBytes * 2);
    expect(parseClientMessage(raw)).toMatchObject({ ok: false, code: "too_large" });
  });

  it("drops unknown fields so nothing extra is ever relayed", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        t: "status",
        status: { state: "busy", project: "bb", threads: 2, provider: "codex", title: "SECRET", path: "/Users/x" },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: { t: "status", status: { state: "busy", project: "bb", threads: 2, provider: "codex" } },
    });
  });

  it("cleanText strips control and bidi characters", () => {
    expect(cleanText("a\u0007b‮c​d", 10)).toBe("a b c d");
  });
});
