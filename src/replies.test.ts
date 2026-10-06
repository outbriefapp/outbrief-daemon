import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplyPayload } from "./client.ts";
import type { ExecuteResult } from "./executor.ts";
import { createReplyHandler, INTERRUPTED_ERROR } from "./replies.ts";
import { StateStore } from "./state.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(resume: () => Promise<ExecuteResult>) {
  const dir = mkdtempSync(join(tmpdir(), "outbrief-replies-"));
  dirs.push(dir);
  const state = new StateStore(join(dir, "state.json"));
  state.rememberSession("s1", { agent: "claude-code", cwd: "/srv/app", updatedAt: "t" });
  const runs: string[] = [];
  const posts: string[] = [];
  const settled: Array<{ replyId: string; status: string; error?: string }> = [];
  const handle = createReplyHandler({
    state,
    open: () => ({
      sessionId: "s1",
      content: "继续",
      multica: { workspaceId: "w", issueId: "i", reportCommentId: "c" },
    }),
    postToMultica: async (_target, content) => {
      posts.push(content);
      return "comment-1";
    },
    resume: async (_agent, sessionId) => {
      runs.push(sessionId);
      return resume();
    },
    settle: (replyId, status, error) => settled.push({ replyId, status, error }),
    failPlain: (replyId, error) => settled.push({ replyId, status: "failed", error }),
    log: () => {},
  });
  return { state, handle, runs, posts, settled };
}

const reply = (source = "claude-code"): ReplyPayload => ({
  id: "r1",
  eventId: "e1",
  source,
  sealed: "sealed",
});

describe("createReplyHandler", () => {
  it("ignores a copy re-sent on reconnect while the first is still running", async () => {
    let finish: (result: ExecuteResult) => void = () => {};
    const { handle, runs, settled } = setup(
      () => new Promise<ExecuteResult>((resolve) => (finish = resolve)),
    );
    const first = handle(reply());
    await handle(reply());
    expect(runs).toEqual(["s1"]);
    finish({ exitCode: 0 });
    await first;
    expect(settled).toEqual([{ replyId: "r1", status: "delivered", error: undefined }]);
  });

  it("answers a finished reply from the log without running it again", async () => {
    const { handle, runs, settled } = setup(async () => ({ exitCode: 0 }));
    await handle(reply());
    await handle(reply());
    expect(runs).toHaveLength(1);
    expect(settled.map((s) => s.status)).toEqual(["delivered", "delivered"]);
  });

  it("fails a reply that was running when the daemon restarted instead of re-running it", async () => {
    // A fresh daemon process whose log still says `running`.
    const restarted = setup(async () => ({ exitCode: 0 }));
    restarted.state.setReply("r1", { status: "running", error: null, at: "t" });
    await restarted.handle(reply());
    await restarted.handle(reply("multica"));
    expect(restarted.runs).toEqual([]);
    expect(restarted.posts).toEqual([]);
    expect(restarted.settled[0]).toEqual({
      replyId: "r1",
      status: "failed",
      error: INTERRUPTED_ERROR,
    });
    expect(restarted.state.reply("r1")?.status).toBe("failed");
  });

  it("posts a Multica reply once even when re-sent mid-post", async () => {
    const { handle, posts, settled } = setup(async () => ({ exitCode: 0 }));
    await Promise.all([handle(reply("multica")), handle(reply("multica"))]);
    expect(posts).toEqual(["继续"]);
    expect(settled).toHaveLength(1);
  });
});
