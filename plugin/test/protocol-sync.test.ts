import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

it("lib/protocol.ts is an exact copy of worker/src/protocol.ts", () => {
  expect(read("../lib/protocol.ts")).toBe(read("../../worker/src/protocol.ts"));
});
