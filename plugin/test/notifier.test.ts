import { beforeEach, describe, expect, it, vi } from "vitest";

import { Notifier } from "../components/notifier";
import { CHANNEL_POKE, CHANNEL_REACT } from "../lib/rpc";

const { handlers, toast } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  toast: vi.fn(),
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: (channel: string, handler: (payload: unknown) => void) => {
    handlers.set(channel, handler);
  },
}));
vi.mock("sonner", () => ({ toast }));

describe("Friends notifications", () => {
  beforeEach(() => {
    handlers.clear();
    toast.mockClear();
    Notifier();
  });

  it("keeps visible spacing between the poke emoji and the sender", () => {
    handlers.get(CHANNEL_POKE)!({ fromName: "Bo" });

    expect(toast).toHaveBeenCalledWith("👉\u00a0Bo poked you");
  });

  it("keeps visible spacing between the reaction emoji and the sender", () => {
    handlers.get(CHANNEL_REACT)!({ fromName: "Bo", emoji: "🙌" });

    expect(toast).toHaveBeenCalledWith("🙌\u00a0Bo sent you a reaction");
  });
});
