import { describe, expect, it } from "vitest";
import { fromStopHook, lastAssistantTextFromTranscript, type StopHookDeps } from "./normalize.ts";

const deps: StopHookDeps = {
  readTranscript: () => {
    throw new Error("transcript must not be read");
  },
  isSavedCodexThread: () => true,
};

describe("fromStopHook (claude-code)", () => {
  it("uses last_assistant_message and keeps the session id for later resume", () => {
    expect(
      fromStopHook(
        "claude-code",
        {
          session_id: "s-1",
          cwd: "/work/outbrief",
          hook_event_name: "Stop",
          stop_hook_active: false,
          last_assistant_message: "Done: refactored auth.",
        },
        deps,
      ),
    ).toEqual({
      source: "claude-code",
      sessionId: "s-1",
      cwd: "/work/outbrief",
      title: "outbrief",
      content: "Done: refactored auth.",
    });
  });

  it("skips a re-entrant stop so a forced continuation is not reported twice", () => {
    expect(
      fromStopHook("claude-code", { stop_hook_active: true, last_assistant_message: "x" }, deps),
    ).toBeNull();
  });

  it("falls back to the transcript when the payload has no message", () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "do it" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "final report" }] },
      }),
      JSON.stringify({ type: "system", subtype: "stop_hook_summary" }),
    ].join("\n");
    const event = fromStopHook(
      "claude-code",
      { transcript_path: "/t.jsonl" },
      { ...deps, readTranscript: (p) => (p === "/t.jsonl" ? transcript : undefined) },
    );
    expect(event?.content).toBe("final report");
  });

  it("returns null when neither payload nor transcript has text", () => {
    expect(
      fromStopHook(
        "claude-code",
        { transcript_path: "/missing" },
        { ...deps, readTranscript: () => undefined },
      ),
    ).toBeNull();
  });
});

describe("lastAssistantTextFromTranscript", () => {
  it("skips trailing tool-only assistant entries and malformed lines", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      }),
      "{not json",
      "",
    ].join("\n");
    expect(lastAssistantTextFromTranscript(jsonl)).toBe("a\nb");
  });
});

describe("fromStopHook (codex)", () => {
  // Captured from `codex exec` 0.157.1 with a ~/.codex/hooks.json Stop hook.
  const payload = {
    session_id: "01a0e70b-7216-78f2-b0fc-d9621a43bc33",
    turn_id: "01a0e70b-723e-7e33-96bc-d92ad5f31d23",
    transcript_path:
      "/h/.codex/sessions/2026/09/28/rollout-x-01a0e70b-7216-78f2-b0fc-d9621a43bc33.jsonl",
    cwd: "/w/api",
    hook_event_name: "Stop",
    model: "gpt-6-astra",
    permission_mode: "bypassPermissions",
    stop_hook_active: false,
    last_assistant_message: "All tests pass.",
  };

  it("maps the Stop payload with the thread id as session id", () => {
    expect(fromStopHook("codex", payload, deps)).toEqual({
      source: "codex",
      sessionId: payload.session_id,
      cwd: "/w/api",
      title: "api",
      content: "All tests pass.",
    });
  });

  it("ignores empty messages without reading the rollout", () => {
    expect(fromStopHook("codex", { ...payload, last_assistant_message: null }, deps)).toBeNull();
  });

  it("skips turns of threads Codex never saved, such as its background title generation", () => {
    const turn = (threadId: string) =>
      fromStopHook(
        "codex",
        { ...payload, session_id: threadId, last_assistant_message: '{"title":"回复行"}' },
        { ...deps, isSavedCodexThread: (id) => id === "t-user" },
      );
    expect(turn("t-title")).toBeNull();
    expect(turn("t-user")).toMatchObject({ sessionId: "t-user" });
  });
});
