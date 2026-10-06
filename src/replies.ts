import type { ReplyPayload } from "./client.ts";
import type { SealedReply } from "./e2e/payloads.ts";
import type { ExecuteResult } from "./executor.ts";
import type { AgentKind, StateStore } from "./state.ts";
import { errorText } from "./util.ts";

/** Why a reply that was mid-run when the daemon stopped is failed rather than run again. */
export const INTERRUPTED_ERROR =
  "执行到一半时这台电脑上的 daemon 重启了，结果未知；为避免重复执行，没有再跑一遍";

export interface ReplyHandlerOptions {
  state: Pick<StateStore, "reply" | "setReply" | "session">;
  open: (eventId: string, sealed: string) => SealedReply;
  /** Posts a Multica reply as the user's comment; resolves the comment id. */
  postToMultica: (target: NonNullable<SealedReply["multica"]>, content: string) => Promise<string>;
  resume: (
    agent: AgentKind,
    sessionId: string,
    cwd: string,
    content: string,
  ) => Promise<ExecuteResult>;
  /** Reports an outcome, sealing the reason. */
  settle: (
    replyId: string,
    status: "delivered" | "failed",
    error?: string,
    commentId?: string,
  ) => void;
  /** Reports a failure in the clear: the reply could not be opened with this machine's key. */
  failPlain: (replyId: string, error: string) => void;
  log: (msg: string) => void;
}

/**
 * Runs each reply at most once (YOUT-180). The server re-sends every `dispatched` reply when the
 * WebSocket reconnects, so the same id can arrive again while it is still running — that copy is
 * dropped and the running one reports when it ends. A reply found `running` in the log was cut off
 * by a daemon restart: whether the agent or the comment already went through is unknown, so it is
 * failed instead of run a second time.
 */
export function createReplyHandler(
  options: ReplyHandlerOptions,
): (reply: ReplyPayload) => Promise<void> {
  const { state, settle, log } = options;
  const inFlight = new Set<string>();

  const finish = (
    replyId: string,
    status: "delivered" | "failed",
    error?: string,
    commentId?: string,
  ): void => {
    state.setReply(replyId, {
      status,
      error: error ?? null,
      ...(commentId ? { commentId } : {}),
      at: new Date().toISOString(),
    });
    settle(replyId, status, error, commentId);
  };

  const execute = async (reply: ReplyPayload): Promise<void> => {
    const { id: replyId } = reply;
    const existing = state.reply(replyId);
    if (existing && (existing.status === "delivered" || existing.status === "failed")) {
      if (existing.plainError) options.failPlain(replyId, existing.error ?? "");
      else
        settle(
          replyId,
          existing.status,
          existing.error ?? undefined,
          existing.commentId ?? undefined,
        );
      return;
    }
    if (existing?.status === "running") {
      log(`reply ${replyId}: was running when the daemon stopped — failed, not run again`);
      finish(replyId, "failed", INTERRUPTED_ERROR);
      return;
    }

    let opened: SealedReply;
    try {
      opened = options.open(reply.eventId, reply.sealed);
    } catch (err) {
      // Not sealed with this machine's key: the reason is sent in the clear (it holds no content),
      // since the app that sealed the reply with another key could not open a sealed one either.
      const error = `无法解密回复（${errorText(err).slice(0, 200)}）：请确认 App 和这台电脑的加密密钥一致`;
      log(`reply ${replyId}: ${error}`);
      state.setReply(replyId, {
        status: "failed",
        error,
        plainError: true,
        at: new Date().toISOString(),
      });
      options.failPlain(replyId, error);
      return;
    }
    const { sessionId, content } = opened;

    state.setReply(replyId, { status: "running", error: null, at: new Date().toISOString() });

    // A Multica report: post the reply as the user's comment under the agent's report.
    if (reply.source === "multica") {
      if (!opened.multica) {
        finish(replyId, "failed", "回复里没有 Multica 评论位置");
        return;
      }
      try {
        const commentId = await options.postToMultica(opened.multica, content);
        finish(replyId, "delivered", undefined, commentId);
        log(`reply ${replyId}: posted to Multica as comment ${commentId}`);
      } catch (err) {
        const error = errorText(err).slice(0, 1000);
        finish(replyId, "failed", error);
        log(`reply ${replyId}: Multica post failed — ${error}`);
      }
      return;
    }

    // Resolve cwd from our local session record only; the server's copy is never trusted.
    const sessionRecord = sessionId ? state.session(sessionId) : undefined;
    const cwd = sessionRecord?.cwd;
    if (!sessionRecord || !cwd) {
      const error = "cwd unknown — no session record found";
      log(`reply ${replyId}: ${error}`);
      finish(replyId, "failed", error);
      return;
    }

    log(`Resuming ${sessionRecord.agent} session=${sessionId ?? "-"} replyId=${replyId}`);
    const result = await options.resume(sessionRecord.agent, sessionId ?? "", cwd, content);
    const status = result.exitCode === 0 ? "delivered" : "failed";
    finish(replyId, status, result.error);
    log(`reply ${replyId}: ${status}${result.error ? ` — ${result.error}` : ""}`);
  };

  return async (reply) => {
    if (inFlight.has(reply.id)) {
      log(`reply ${reply.id}: re-sent while still running — ignored`);
      return;
    }
    inFlight.add(reply.id);
    try {
      await execute(reply);
    } finally {
      inFlight.delete(reply.id);
    }
  };
}
