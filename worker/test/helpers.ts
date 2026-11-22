import { SELF } from "cloudflare:test";

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type Status,
} from "../src/protocol";

export const status = (over: Partial<Status> = {}): Status => ({
  state: "idle",
  project: null,
  threads: 0,
  provider: null,
  ...over,
});

/** A random documentation-range IPv6 address, so tests don't share a creation limit. */
export const randomIp = (): string =>
  `2001:db8::${crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16)}:${crypto
    .getRandomValues(new Uint16Array(1))[0]!
    .toString(16)}`;

export const postRoom = (ip: string | null = randomIp()): Promise<Response> =>
  SELF.fetch("http://edge/rooms", {
    method: "POST",
    headers: ip === null ? {} : { "cf-connecting-ip": ip },
  });

export async function createRoom(): Promise<string> {
  const res = await postRoom();
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return ((await res.json()) as { code: string }).code;
}

/** A simulated client: records every frame; `next` waits for a matching one. */
export class Client {
  readonly frames: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  private constructor(
    readonly ws: WebSocket,
    readonly cid: string,
  ) {
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data as string) as ServerMessage;
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(frame)) return true;
        w.resolve(frame);
        return false;
      });
    });
    ws.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
    });
  }

  static async open(code: string, cid = crypto.randomUUID().replaceAll("-", "")): Promise<Client> {
    const res = await SELF.fetch(`http://edge/rooms/${code}/ws`, {
      headers: { Upgrade: "websocket" },
    });
    if (!res.webSocket) throw new Error(`no websocket, status ${res.status}`);
    res.webSocket.accept();
    return new Client(res.webSocket, cid);
  }

  static async join(code: string, name: string, over: { cid?: string; status?: Status } = {}) {
    const client = await Client.open(code, over.cid);
    client.send({
      t: "hello",
      v: PROTOCOL_VERSION,
      cid: client.cid,
      name,
      ...(over.status ? { status: over.status } : {}),
    });
    const welcome = await client.next((m) => m.t === "welcome");
    if (welcome.t !== "welcome") throw new Error("unreachable");
    return { client, id: welcome.you, welcome };
  }

  send(message: ClientMessage | string): void {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  next<T extends ServerMessage["t"]>(
    pred: T | ((m: ServerMessage) => boolean),
    timeoutMs = 2000,
  ): Promise<ServerMessage & { t: T }> {
    const test = typeof pred === "string" ? (m: ServerMessage) => m.t === pred : pred;
    const seen = this.frames.length;
    void seen;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out; frames: ${JSON.stringify(this.frames)}`)),
        timeoutMs,
      );
      this.waiters.push({
        pred: test,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as ServerMessage & { t: T });
        },
      });
    });
  }

  /** Waits for the server to settle, then reports frames of a type seen since `from`. */
  async quiet(ms = 60): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  of<T extends ServerMessage["t"]>(t: T): (ServerMessage & { t: T })[] {
    return this.frames.filter((m): m is ServerMessage & { t: T } => m.t === t);
  }
}
