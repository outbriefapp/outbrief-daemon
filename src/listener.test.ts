import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_REPORT_BYTES, startListener } from "./listener.ts";
import { StateStore } from "./state.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function listen() {
  const dir = mkdtempSync(join(tmpdir(), "outbrief-listener-"));
  const state = new StateStore(join(dir, "state.json"));
  const added: unknown[] = [];
  const port = await freePort();
  const listener = startListener(
    { localPort: port },
    state,
    {
      add: (entry: unknown) => {
        added.push(entry);
        return "id";
      },
    } as never,
    () => {},
  );
  cleanups.push(() => {
    listener.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // Wait until the socket accepts connections.
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
    });
    if (up) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { port, state, added };
}

function post(
  port: number,
  body: string | Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/report", method: "POST", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const report = JSON.stringify({
  source: "claude-code",
  content: "done",
  sessionId: "s1",
  cwd: "/srv/app",
});

describe("POST /report", () => {
  it("accepts the hook's local JSON request", async () => {
    const { port, state, added } = await listen();
    const res = await post(port, report, {
      Host: `127.0.0.1:${port}`,
      "Content-Type": "application/json",
    });
    expect(res.status).toBe(202);
    expect(added).toHaveLength(1);
    expect(state.session("s1")?.cwd).toBe("/srv/app");
  });

  it("refuses a web page's request: it carries an Origin", async () => {
    const { port, state, added } = await listen();
    const res = await post(port, report, {
      Host: `127.0.0.1:${port}`,
      "Content-Type": "text/plain",
      Origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(added).toHaveLength(0);
    expect(state.session("s1")).toBeUndefined();
  });

  it("refuses a DNS-rebound host and non-JSON bodies", async () => {
    const { port, added } = await listen();
    const rebound = await post(port, report, {
      Host: `evil.example:${port}`,
      "Content-Type": "application/json",
    });
    expect(rebound.status).toBe(403);
    const plain = await post(port, report, {
      Host: `localhost:${port}`,
      "Content-Type": "text/plain",
    });
    expect(plain.status).toBe(415);
    expect(added).toHaveLength(0);
  });

  it("refuses a body over the size limit", async () => {
    const { port, added } = await listen();
    const res = await post(port, Buffer.alloc(MAX_REPORT_BYTES + 1, "a"), {
      Host: `127.0.0.1:${port}`,
      "Content-Type": "application/json",
    }).catch(() => ({ status: 413, body: "" }));
    expect(res.status).toBe(413);
    expect(added).toHaveLength(0);
  });
});
