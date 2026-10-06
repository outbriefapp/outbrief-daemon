import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("hook command", () => {
  let checkout: string | undefined;
  afterEach(() => {
    if (checkout) rmSync(checkout, { recursive: true, force: true });
  });

  // YOUT-244: Multica deletes node_modules from finished task checkouts, while ~/.claude/settings.json
  // still runs the Stop hook from there. The hook must load nothing but Node built-ins.
  it("runs from a checkout without node_modules", () => {
    checkout = mkdtempSync(join(tmpdir(), "outbrief-hook-"));
    cpSync(srcDir, join(checkout, "src"), { recursive: true });
    copyFileSync(join(dirname(srcDir), "package.json"), join(checkout, "package.json"));
    const env: NodeJS.ProcessEnv = { ...process.env, OUTBRIEF_HOME: join(checkout, "home") };
    delete env.MULTICA_ISSUE_ID;
    delete env.MULTICA_TASK_ID;

    const result = spawnSync(
      process.execPath,
      [join(checkout, "src", "cli.ts"), "hook", "claude-code", "--dry-run"],
      {
        env,
        encoding: "utf8",
        input: JSON.stringify({
          session_id: "s1",
          cwd: checkout,
          last_assistant_message: "done",
        }),
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"sessionId": "s1"');
  });
});
