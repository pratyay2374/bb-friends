import { useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import {
  CHANNEL_NOTICE,
  CHANNEL_POKE,
  CHANNEL_REACT,
  type NoticePayload,
  type PokePayload,
  type ReactPayload,
} from "../lib/rpc";

const text = (value: unknown, fallback: string): string =>
  typeof value === "string" && value !== "" ? value.slice(0, 60) : fallback;

/**
 * Mounted for the whole app session (an app overlay), renders nothing: it turns
 * server-published signals into bb toasts, which also land in bb's
 * notification center. Payloads are plain text; React never treats them as HTML.
 */
export function Notifier() {
  useRealtime(CHANNEL_POKE, (payload) => {
    const { fromName } = (payload ?? {}) as Partial<PokePayload>;
    toast(`👉\u00a0${text(fromName, "A friend")} poked you`);
  });
  useRealtime(CHANNEL_REACT, (payload) => {
    const { fromName, emoji } = (payload ?? {}) as Partial<ReactPayload>;
    toast(`${text(emoji, "👍")}\u00a0${text(fromName, "A friend")} sent you a reaction`);
  });
  useRealtime(CHANNEL_NOTICE, (payload) => {
    const { message } = (payload ?? {}) as Partial<NoticePayload>;
    toast.error(text(message, "Something went wrong"));
  });
  return null;
}
