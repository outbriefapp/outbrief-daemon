import { describe, expect, it } from "vitest";
import { run } from "./executor.ts";

const node = process.execPath;

describe("run", () => {
  it("finishes when the agent writes a lot to stdout", async () => {
    const result = await run(node, ["-e", "process.stdout.write('x'.repeat(2_000_000))"], ".");
    expect(result).toEqual({ exitCode: 0, error: undefined });
  });

  it("does not wait on stdin", async () => {
    const result = await run(node, ["-e", "process.stdin.resume()"], ".", 5_000);
    expect(result.exitCode).toBe(0);
  });

  it("reports the stderr tail when the agent fails", async () => {
    const result = await run(
      node,
      ["-e", "process.stderr.write('a'.repeat(5000) + 'boom'); process.exit(3)"],
      ".",
    );
    expect(result.exitCode).toBe(3);
    expect(result.error).toHaveLength(1000);
    expect(result.error?.endsWith("boom")).toBe(true);
  });

  it("stops a run that exceeds the timeout", async () => {
    const result = await run(node, ["-e", "setInterval(() => {}, 1000)"], ".", 200);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("已停止");
  });
});
