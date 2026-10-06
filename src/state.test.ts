import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "./state.ts";

const dirs: string[] = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "outbrief-state-"));
  dirs.push(dir);
  return join(dir, "state.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("persists session cwd and reply outcomes across restarts", () => {
    const path = tempPath();
    const first = new StateStore(path);
    first.rememberSession("s1", { agent: "claude-code", cwd: "/srv/app", updatedAt: "t" });
    first.setReply("r1", { status: "delivered", error: null, at: "t" });

    const reopened = new StateStore(path);
    expect(reopened.session("s1")?.cwd).toBe("/srv/app");
    // A replayed reply id is answered from the log, never executed again.
    expect(reopened.reply("r1")?.status).toBe("delivered");
    expect(reopened.reply("r2")).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("starts empty when the file is missing or corrupt", () => {
    expect(new StateStore(tempPath()).session("x")).toBeUndefined();
  });
});
