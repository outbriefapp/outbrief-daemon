import { basename } from "node:path";
import type { AgentEventInput } from "../brief/schema.ts";

export type HookAdapter = "claude-code" | "codex";

/**
 * Stop hook stdin payload (fields we use). Claude Code (`~/.claude/settings.json`) and Codex
 * (`~/.codex/hooks.json`) send the same shape.
 */
export interface StopHookPayload {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  /** Present on recent versions; older Claude Code only has the transcript. */
  last_assistant_message?: string | null;
}

export interface StopHookDeps {
  /** Reads a transcript file; undefined when it cannot be read. */
  readTranscript: (path: string) => string | undefined;
  /** Whether Codex persisted the thread, i.e. `codex resume` can reopen it. */
  isSavedCodexThread: (threadId: string) => boolean;
}

function titleFrom(cwd: string | undefined): string | undefined {
  const name = cwd ? basename(cwd) : "";
  return name || undefined;
}

/**
 * Extracts the text of the last assistant message from a Claude Code transcript (JSONL).
 * Returns undefined when the transcript holds no assistant text.
 */
export function lastAssistantTextFromTranscript(jsonl: string): string | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const e = entry as { type?: string; message?: { content?: unknown } };
    if (e.type !== "assistant") continue;
    const content = e.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (b): b is { type: "text"; text: string } =>
                  b?.type === "text" && typeof b.text === "string",
              )
              .map((b) => b.text)
              .join("\n")
          : "";
    if (text.trim()) return text;
  }
  return undefined;
}

/**
 * Maps a Stop hook payload to the daemon's `/report` body; null when there is nothing to report.
 *
 * - A Stop hook that already forced a continuation fires again; only the final stop is reported.
 * - Claude Code: the transcript is read only when the payload lacks `last_assistant_message`.
 * - Codex: threads it did not persist are internal turns (e.g. the TUI's background task-title
 *   generation) and must not ring the user.
 */
export function fromStopHook(
  adapter: HookAdapter,
  payload: StopHookPayload,
  deps: StopHookDeps,
): AgentEventInput | null {
  if (payload.stop_hook_active) return null;
  let content = payload.last_assistant_message ?? undefined;
  if (!content?.trim() && adapter === "claude-code" && payload.transcript_path) {
    const transcript = deps.readTranscript(payload.transcript_path);
    content = transcript ? lastAssistantTextFromTranscript(transcript) : undefined;
  }
  if (!content?.trim()) return null;
  const sessionId = payload.session_id || undefined;
  if (adapter === "codex" && sessionId && !deps.isSavedCodexThread(sessionId)) return null;
  return {
    source: adapter,
    sessionId,
    cwd: payload.cwd || undefined,
    title: titleFrom(payload.cwd),
    content,
  };
}
