import { errorText } from "../util.ts";
import type { MulticaConfig } from "./client.ts";

/** A finished Multica task that belongs to an issue (chat tasks are skipped). */
export interface CompletedTask {
  taskId: string;
  issueId: string;
  agentId: string;
}

/** A realtime frame; only `type`, `payload` and `error` are read. */
interface Frame {
  type?: string;
  payload?: unknown;
  error?: string;
}

function parseFrame(data: string): Frame | null {
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === "object" ? (value as Frame) : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/** `task:completed` payload as Multica broadcasts it to every member connection of the workspace. */
function parseTaskCompleted(payload: unknown): {
  taskId: string;
  agentId: string;
  issueId?: string | null;
  chatSessionId?: string | null;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.task_id !== "string" || typeof p.agent_id !== "string") return null;
  if (!optionalString(p.issue_id) || !optionalString(p.chat_session_id)) return null;
  return {
    taskId: p.task_id,
    agentId: p.agent_id,
    issueId: p.issue_id,
    chatSessionId: p.chat_session_id,
  };
}

export interface MulticaListenerOptions {
  config: MulticaConfig;
  /** Called once per completed issue task, one at a time in arrival order; a rejection is reported. */
  onTaskCompleted: (task: CompletedTask) => Promise<void>;
  log?: (message: string) => void;
  /** Test seam; the global WebSocket (Node ≥ 22) by default. */
  WebSocket?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a new connection may take to be acknowledged before it is given up. */
  handshakeTimeoutMs?: number;
}

/**
 * Keeps one realtime connection to the Multica workspace (`/ws`, authenticated by the PAT in the first
 * frame) and hands every `task:completed` of an issue task to `onTaskCompleted`. Reconnects with
 * exponential backoff; a connection not acknowledged within `handshakeTimeoutMs` is given up and
 * retried, since a stalled connect or upgrade may never fire "close". Tasks that finish while disconnected are not replayed: Multica's realtime feed
 * has no history, so they produce no call.
 */
export class MulticaListener {
  readonly #options: MulticaListenerOptions;
  readonly #WebSocket: typeof WebSocket;
  readonly #log: (message: string) => void;
  readonly #minBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #handshakeTimeoutMs: number;
  #socket: WebSocket | null = null;
  #connected = false;
  #connectionError: string | null = null;
  #taskError: string | null = null;
  #backoffMs: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;
  #tasks: Promise<void> = Promise.resolve();

  constructor(options: MulticaListenerOptions) {
    this.#options = options;
    this.#WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.#log = options.log ?? ((message) => console.log(message));
    this.#minBackoffMs = options.minBackoffMs ?? 1_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 20_000;
    this.#backoffMs = this.#minBackoffMs;
  }

  /** Authenticated and listening. */
  get connected(): boolean {
    return this.#connected;
  }

  /** The problem the user should know about: the connection first, then the last failed task. */
  get error(): string | null {
    return this.#connectionError ?? this.#taskError;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  /** Closes the connection, stops reconnecting and waits for the task being processed. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#handshakeTimer);
    this.#socket?.close(1000, "outbrief shutting down");
    this.#socket = null;
    this.#connected = false;
    await this.#tasks;
  }

  #url(): string {
    const url = new URL("/ws", this.#options.config.apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("workspace_id", this.#options.config.workspaceId);
    url.searchParams.set("client_platform", "outbrief-daemon");
    return url.toString();
  }

  #connect(): void {
    let socket: WebSocket;
    try {
      socket = new this.#WebSocket(this.#url());
    } catch (err) {
      this.#connectionError = `无法连接 Multica：${errorText(err)}`;
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    let authenticated = false;
    let rejected = false;

    // YOUT-228: a reconnect once stalled for two hours without "open", "error" or "close".
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = setTimeout(() => {
      if (this.#socket !== socket || authenticated || this.#stopped) return;
      this.#socket = null;
      if (!rejected) this.#connectionError = "Multica 没有响应，正在重连";
      this.#log(
        `Multica: no answer within ${this.#handshakeTimeoutMs} ms; reconnecting in ${this.#backoffMs} ms`,
      );
      // Its "close", if it ever comes, is ignored: it is no longer `#socket`.
      socket.close();
      this.#scheduleReconnect();
    }, this.#handshakeTimeoutMs);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", payload: { token: this.#options.config.token } }));
    });

    socket.addEventListener("message", (message) => {
      if (typeof message.data !== "string") return;
      const frame = parseFrame(message.data);
      if (!frame) return;
      if (!authenticated) {
        if (frame.type === "auth_ack") {
          authenticated = true;
          clearTimeout(this.#handshakeTimer);
          this.#connected = true;
          this.#connectionError = null;
          this.#backoffMs = this.#minBackoffMs;
          this.#log(
            `Multica: listening for finished tasks in workspace ${this.#options.config.workspaceId}`,
          );
        } else if (frame.error) {
          rejected = true;
          this.#connectionError = `Multica 拒绝连接：${frame.error}（检查设置里的 Multica API Token）`;
          this.#log(this.#connectionError);
        }
        return;
      }
      if (frame.type === "task:completed") this.#onTaskCompleted(frame.payload);
    });

    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      clearTimeout(this.#handshakeTimer);
      this.#socket = null;
      this.#connected = false;
      if (this.#stopped) return;
      if (!rejected) {
        this.#connectionError = `Multica 连接断开（${event.code}${event.reason ? ` ${event.reason}` : ""}），正在重连`;
      }
      this.#log(
        `Multica: connection closed (${event.code}); reconnecting in ${this.#backoffMs} ms`,
      );
      this.#scheduleReconnect();
    });

    // A failed connect or a dropped socket is followed by "close", which reconnects.
    socket.addEventListener("error", () => undefined);
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      if (!this.#stopped) this.#connect();
    }, this.#backoffMs);
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#maxBackoffMs);
  }

  #onTaskCompleted(payload: unknown): void {
    const parsed = parseTaskCompleted(payload);
    if (!parsed) {
      this.#log("Multica: ignored a task:completed event with an unexpected payload");
      return;
    }
    const { taskId, agentId, issueId, chatSessionId } = parsed;
    // Chat replies are not issue work: there is no issue thread to report on or reply under.
    if (chatSessionId || !issueId) return;
    this.#tasks = this.#tasks
      .then(() => this.#options.onTaskCompleted({ taskId, issueId, agentId }))
      .then(
        () => {
          this.#taskError = null;
        },
        (err: unknown) => {
          this.#taskError = `Multica 任务 ${taskId} 没能转成来电：${errorText(err)}`;
          this.#log(this.#taskError);
        },
      );
  }
}
