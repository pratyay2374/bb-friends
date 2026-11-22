import { formatRoomCode, normalizeRoomCode } from "./protocol";

/** http(s) base URL -> same URL with no trailing slash, or null if unusable. */
export function parseServerUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

/** A bare origin has pathname "/", so trailing slashes are dropped here. */
const join = (base: URL, path: string): string =>
  `${base.origin}${base.pathname.replace(/\/+$/, "")}${path}`;

export const roomsUrl = (base: URL): string => join(base, "/rooms");
export const roomUrl = (base: URL, code: string): string => join(base, `/rooms/${code}`);

/** wss:// for https, ws:// for http. */
export function roomSocketUrl(base: URL, code: string): string {
  const ws = new URL(join(base, `/rooms/${code}/ws`));
  ws.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return ws.toString();
}

export { formatRoomCode, normalizeRoomCode };
