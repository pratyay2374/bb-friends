import { expect, it } from "vitest";

import { avatarImage, resolveAvatar } from "../lib/avatar";
import { AVATAR_STYLES } from "../lib/protocol";

it("gives legacy members a deterministic Fun Emoji avatar based on member id", () => {
  const avatar = resolveAvatar(undefined, "abc123");
  expect(avatar).toEqual({ style: "fun-emoji", seed: "abc123" });
  expect(avatarImage(resolveAvatar(undefined, "abc123"))).toBe(avatarImage(avatar));
});

it.each(AVATAR_STYLES)("renders %s locally as an SVG image", (style) => {
  const avatar = { style, seed: "custom_seed" };
  expect(resolveAvatar(avatar, "abc123")).toEqual(avatar);
  expect(avatarImage(avatar)).toMatch(/^data:image\/svg\+xml/);
});
