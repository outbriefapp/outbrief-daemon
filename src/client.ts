import type { DaemonConfig } from "./config.ts";

// Minimum wire shapes mirrored from outbrief-server protocol — no package dep.
interface HelloFrame {
  type: "hello";
  machineId: string;
  machineName: string;
}
/** A reply the server relays; `sealed` is the app's `SealedReply` (see `e2e/payloads.ts`). */
export interface ReplyPayload {
  id: string;
  eventId: string;
  source: string;
  sealed: string;
}
interface ReplyFrame {
  type: "reply";
  reply: ReplyPayload;
}
interface PongFrame {
  type: "pong";
}
/** A sealed settings request from an app of this account (a phone has no local daemon to ask). */
interface SettingsFrame {
  type: "settings";
  requestId: string;
  sealed: string;
}
type ServerFrame = HelloFrame | ReplyFrame | SettingsFrame | PongFrame;

// Outbound frames
interface PingFrame {
  type: "ping";
}
interface ResultFrame {
  type: "result";
  replyId: string;
  status: "delivered" | "failed";
  error?: string;
  commentId?: string;
}
interface SettingsResultFrame {
  type: "settings-result";
  requestId: string;
  sealed: string;
}
type DaemonFrame = PingFrame | ResultFrame | SettingsResultFrame;

/** Answers a relayed settings request with the sealed result. */
export type SettingsRelay = (requestId: string, sealed: string) => Promise<string>;

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

// Node's undici WebSocket takes `{ headers }` as the SECOND argument (in place of protocols).
// The DOM WebSocket type doesn't declare that overload, so we cast.
type WsOptions = { headers: Record<string, string> };
type ExtendedWsConstructor = new (url: string, options: WsOptions) => WebSocket;

export class DaemonClient {
  readonly #config: DaemonConfig;
  readonly #onReply: (reply: ReplyPayload) => void;
  readonly #onSettings: SettingsRelay;
  #ws: WebSocket | null = null;
  #stopped = false;
  #backoff = MIN_BACKOFF_MS;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #connected = false;

  constructor(
    config: DaemonConfig,
    onReply: (reply: ReplyPayload) => void,
    onSettings: SettingsRelay,
  ) {
    this.#config = config;
    this.#onReply = onReply;
    this.#onSettings = onSettings;
  }

  get connected(): boolean {
    return this.#connected;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearPing();
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        /* ignore */
      }
      this.#ws = null;
    }
    this.#connected = false;
  }

  sendResult(
    replyId: string,
    status: "delivered" | "failed",
    error?: string,
    commentId?: string,
  ): void {
    if (!this.#ws || this.#ws.readyState !== this.#ws.OPEN) return;
    const frame: ResultFrame = {
      type: "result",
      replyId,
      status,
      ...(error ? { error } : {}),
      ...(commentId ? { commentId } : {}),
    };
    this.#ws.send(JSON.stringify(frame));
  }

  #connect(): void {
    if (this.#stopped) return;

    const wsUrl = `${this.#config.serverUrl.replace(/^http/, "ws")}/v1/daemon`;
    const WS = globalThis.WebSocket as unknown as ExtendedWsConstructor;
    const ws = new WS(wsUrl, {
      headers: { Authorization: `Bearer ${this.#config.token}` },
    });
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#backoff = MIN_BACKOFF_MS;
      this.#startPing();
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "hello") {
        this.#connected = true;
        return;
      }
      if (frame.type === "reply") {
        this.#onReply(frame.reply);
        return;
      }
      if (frame.type === "settings") {
        void this.#answerSettings(ws, frame);
        return;
      }
      // pong — no action needed; the ping timer handles liveness
    });

    // A connect that fails (server down, refused) fires only "error" in Node's WebSocket, never
    // "close"; a dropped connection fires both. Either way, reconnect once per socket.
    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      if (this.#ws === ws) this.#ws = null;
      this.#connected = false;
      this.#clearPing();
      this.#scheduleReconnect();
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }

  async #answerSettings(ws: WebSocket, frame: SettingsFrame): Promise<void> {
    const sealed = await this.#onSettings(frame.requestId, frame.sealed);
    if (ws.readyState !== ws.OPEN) return;
    const answer: DaemonFrame = { type: "settings-result", requestId: frame.requestId, sealed };
    ws.send(JSON.stringify(answer));
  }

  #startPing(): void {
    this.#clearPing();
    this.#pingTimer = setInterval(() => {
      if (this.#ws && this.#ws.readyState === this.#ws.OPEN) {
        const frame: DaemonFrame = { type: "ping" };
        this.#ws.send(JSON.stringify(frame));
      }
    }, PING_INTERVAL_MS);
  }

  #clearPing(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    setTimeout(() => {
      this.#connect();
    }, this.#backoff);
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
  }
}
