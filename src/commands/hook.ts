/**
 * `outbrief-daemon hook <claude-code|codex>` — the agents' Stop hook.
 *
 * Reads the Stop payload from stdin and posts the final report to this machine's daemon at
 * 127.0.0.1:<localPort>/report; the daemon writes the brief and submits it to the server.
 *
 * Runs on every agent turn, so it only imports dependency-free modules (cli.ts loads commands
 * lazily) and always exits 0: a hook failure must never block or fail the agent.
 *
 * `--dry-run` prints what would be reported instead of posting it: a posted report rings the user,
 * so tests of the hook must never reach the running daemon (YOUT-201).
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOCAL_PORT, outbriefHome } from "../home.ts";
import { fromStopHook, type HookAdapter, type StopHookPayload } from "../hook/normalize.ts";

const POST_TIMEOUT_MS = 5_000;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readTranscript(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isSavedCodexThread(threadId: string): boolean {
  const sessions = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  let files: string[];
  try {
    files = readdirSync(sessions, { recursive: true, encoding: "utf8" });
  } catch {
    return true;
  }
  return files.some((file) => file.endsWith(`-${threadId}.jsonl`));
}

function parsePayload(raw: string): StopHookPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StopHookPayload) : {};
  } catch {
    return {};
  }
}

function localPort(): number {
  try {
    const raw = readFileSync(join(outbriefHome(), "daemon.json"), "utf8");
    const cfg = JSON.parse(raw) as { localPort?: unknown };
    return typeof cfg.localPort === "number" ? cfg.localPort : DEFAULT_LOCAL_PORT;
  } catch {
    return DEFAULT_LOCAL_PORT;
  }
}

async function postReport(adapter: string | undefined, dryRun: boolean): Promise<void> {
  if (adapter !== "claude-code" && adapter !== "codex") {
    throw new Error(`unknown adapter "${adapter ?? ""}", expected claude-code | codex`);
  }
  // YOUT-175: inside Multica the daemon reads the report from Multica; posting here would ring twice.
  if (process.env.MULTICA_ISSUE_ID?.trim() || process.env.MULTICA_TASK_ID?.trim()) {
    if (dryRun) process.stdout.write("skipped: inside a Multica task (reported from Multica)\n");
    return;
  }

  const event = fromStopHook(adapter satisfies HookAdapter, parsePayload(readStdin()), {
    readTranscript,
    isSavedCodexThread,
  });
  if (dryRun) {
    process.stdout.write(
      event ? `${JSON.stringify(event, null, 2)}\n` : "skipped: nothing to report\n",
    );
    return;
  }
  if (!event) return;

  try {
    const resp = await fetch(`http://127.0.0.1:${localPort()}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...event, occurredAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      process.stderr.write(
        `[outbrief hook] daemon returned ${resp.status}: ${(await resp.text()).slice(0, 200)}\n`,
      );
    }
  } catch {
    // Daemon not running — the report is dropped; never block the agent.
  }
}

export async function hookCommand(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const adapter = argv.find((arg) => arg !== "--dry-run");
  try {
    await postReport(adapter, dryRun);
  } catch (err) {
    process.stderr.write(`[outbrief hook] ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
