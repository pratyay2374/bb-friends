import type { ClientMessage, ServerMessage, Status } from "./protocol";
import { CLOSE, PROTOCOL_VERSION } from "./protocol";
import type { ConnectionState } from "./room-state";

/** The slice of the WHATWG WebSocket this module uses (Node 22 has it global). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const OPEN = 1;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const PING_MS = 25_000;
/** No frame (not even a pong) for this long means the link is dead. */
const SILENCE_MS = 70_000;

export interface ConnectionOptions {
  /** ws:// or wss:// URL of /rooms/:code/ws. */
  url: string;
  /** Stable per-install id; lets the server treat a reconnect as one member. */
  cid: string;
  name: string;
  getStatus: () => Status;
  createSocket: (url: string) => SocketLike;
  onMessage: (message: ServerMessage) => void;
  onState: (state: ConnectionState) => void;
  /** The server told us to stop (room full, protocol error). No reconnect. */
  onFatal: (reason: string) => void;
  log?: (message: string) => void;
  random?: () => number;
}

/** One room connection: hello on open, ping, silence watchdog, backoff. */
export class FriendsConnection {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private stopped = true;
  private timers: { retry?: ReturnType<typeof setTimeout>; ping?: ReturnType<typeof setInterval>; watchdog?: ReturnType<typeof setTimeout> } = {};

  constructor(private readonly options: ConnectionOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = socket.onmessage = socket.onerror = socket.onopen = null;
      try {
        socket.close(1000, "bye");
      } catch {
        // already closed
      }
    }
    this.options.onState("disconnected");
  }

  /** Sends if connected; returns false (and drops the frame) otherwise. */
  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    this.options.onState("connecting");
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch (cause) {
      this.options.log?.(`could not open socket: ${String(cause)}`);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          t: "hello",
          v: PROTOCOL_VERSION,
          cid: this.options.cid,
          name: this.options.name,
          status: this.options.getStatus(),
        } satisfies ClientMessage),
      );
      this.timers.ping = setInterval(() => {
        if (socket.readyState === OPEN) socket.send("ping");
      }, PING_MS);
      this.armWatchdog(socket);
    };
    socket.onmessage = (event) => {
      this.armWatchdog(socket);
      if (typeof event.data !== "string" || event.data === "pong") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null || typeof message.t !== "string") return;
      if (message.t === "welcome") {
        this.attempt = 0;
        this.options.onState("connected");
      }
      this.options.onMessage(message);
    };
    socket.onerror = () => {
      // The close event follows and drives the retry.
    };
    socket.onclose = (event) => {
      this.clearTimers();
      this.socket = null;
      if (this.stopped) return;
      if (event.code === CLOSE.roomFull) return this.fatal("This room is full.");
      if (event.code === CLOSE.badHello) return this.fatal("The server rejected this client.");
      if (event.code === CLOSE.replaced) return this.fatal("Another bb window took over this connection.");
      this.options.onState("disconnected");
      this.scheduleRetry();
    };
  }

  private fatal(reason: string): void {
    this.stopped = true;
    this.options.onState("disconnected");
    this.options.onFatal(reason);
  }

  private armWatchdog(socket: SocketLike): void {
    clearTimeout(this.timers.watchdog);
    this.timers.watchdog = setTimeout(() => {
      this.options.log?.("connection went silent; reconnecting");
      socket.close(4009, "silent");
    }, SILENCE_MS);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    const jitter = 0.5 + (this.options.random ?? Math.random)() * 0.5;
    this.timers.retry = setTimeout(() => this.connect(), Math.round(base * jitter));
  }

  private clearTimers(): void {
    clearTimeout(this.timers.retry);
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.watchdog);
    this.timers = {};
  }
}
