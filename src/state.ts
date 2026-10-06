import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { outbriefHome } from "./config.ts";

export type AgentKind = "claude-code" | "codex";

/** What this machine knows about one agent session; the server's copy is never trusted for `cwd`. */
export interface SessionRecord {
  agent: AgentKind;
  cwd: string;
  updatedAt: string;
}

export type ReplyOutcome = "delivered" | "failed";

/** A reply this machine already accepted; replayed ids are answered from here, never re-run. */
export interface ReplyRecord {
  status: "running" | ReplyOutcome;
  error: string | null;
  /** Multica comment a delivered Multica reply was posted as. */
  commentId?: string | null;
  /** `error` is reported unsealed: the reply itself could not be opened with this machine's key. */
  plainError?: boolean;
  /** The server has acknowledged the outcome frame. Not tracked: the daemon re-sends on reconnect. */
  at: string;
}

interface StateFile {
  sessions: Record<string, SessionRecord>;
  replies: Record<string, ReplyRecord>;
}

/**
 * `~/.outbrief/state.json`: session → cwd records and the reply-id dedup log. Written atomically
 * (temp file + rename) after every change so a crash never runs a reply twice.
 */
export class StateStore {
  readonly #path: string;
  #data: StateFile;

  constructor(path = join(outbriefHome(), "state.json")) {
    this.#path = path;
    this.#data = load(path);
  }

  rememberSession(sessionId: string, record: SessionRecord): void {
    this.#data.sessions[sessionId] = record;
    this.#save();
  }

  session(sessionId: string): SessionRecord | undefined {
    return this.#data.sessions[sessionId];
  }

  reply(replyId: string): ReplyRecord | undefined {
    return this.#data.replies[replyId];
  }

  setReply(replyId: string, record: ReplyRecord): void {
    this.#data.replies[replyId] = record;
    this.#save();
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data), { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}

function load(path: string): StateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>;
    return { sessions: parsed.sessions ?? {}, replies: parsed.replies ?? {} };
  } catch {
    return { sessions: {}, replies: {} };
  }
}
