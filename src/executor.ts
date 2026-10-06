import { spawn } from "node:child_process";
import type { DaemonConfig } from "./config.ts";
import type { AgentKind } from "./state.ts";
import { which } from "./util.ts";

export interface ExecuteResult {
  exitCode: number;
  error?: string;
}

/**
 * Resumes an agent session with the user's reply. Uses argv arrays — no shell interpolation.
 * The `cwd` is always taken from this machine's own session record (see `state.ts`), never the
 * server's copy.
 *
 * Claude Code: `claude -p <reply> --resume <sessionId> [--permission-mode <mode>] [--add-dir <d>]`
 * Codex:       `codex exec -s <sandbox> resume <sessionId> <reply>`
 */
export async function resumeSession(
  agent: AgentKind,
  sessionId: string,
  cwd: string,
  reply: string,
  config: DaemonConfig,
): Promise<ExecuteResult> {
  if (agent === "claude-code") {
    const claude = await which("claude");
    if (!claude) return { exitCode: 1, error: "claude binary not found on PATH" };
    const argv = [
      "-p",
      reply,
      "--resume",
      sessionId,
      "--permission-mode",
      config.claude.permissionMode,
    ];
    for (const dir of config.claude.addDirs) argv.push("--add-dir", dir);
    return run(claude, argv, cwd);
  }
  // codex
  const codex = await which("codex");
  if (!codex) return { exitCode: 1, error: "codex binary not found on PATH" };
  const argv = ["exec", "-s", config.codex.sandbox, "resume", sessionId, reply];
  return run(codex, argv, cwd);
}

/** A resumed turn that runs longer than this is stopped and reported as failed. */
export const RUN_TIMEOUT_MS = 60 * 60 * 1000;
/** Grace between SIGTERM and SIGKILL once a run times out. */
const KILL_GRACE_MS = 10_000;
/** Only the tail of stderr is kept for the failure reason. */
const STDERR_TAIL = 1000;

/**
 * Runs the agent to exit. stdout is discarded: the agent's answer reaches the user as its next report
 * through the hook, and an unread pipe would fill up and stall the child forever. stdin is closed so
 * `-p` never waits on it.
 */
export function run(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          exitCode: 1,
          error: `超过 ${Math.round(timeoutMs / 60_000)} 分钟没有结束，已停止`,
        });
        return;
      }
      const exitCode = code ?? 1;
      resolve({ exitCode, error: exitCode !== 0 ? stderr : undefined });
    });
  });
}
