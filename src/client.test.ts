import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { DaemonClient } from "./client.ts";
import type { DaemonConfig } from "./config.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function config(port: number): DaemonConfig {
  return {
    serverUrl: `http://127.0.0.1:${port}`,
    token: "obm_test",
    machineId: "m1",
    machineName: "mac",
    localPort: 0,
    claude: { permissionMode: "acceptEdits", addDirs: [] },
    codex: { sandbox: "workspace-write" },
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > 8_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("DaemonClient", () => {
  it("keeps retrying when the server is not up yet, and connects once it is", async () => {
    const port = await freePort();
    const client = new DaemonClient(
      config(port),
      () => undefined,
      async () => "",
    );
    client.start();
    cleanup.push(() => client.stop());
    // The first attempt fails: nothing listens on the port yet.
    await new Promise((r) => setTimeout(r, 300));
    expect(client.connected).toBe(false);

    const server: Server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "hello" })));
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => {
      for (const ws of wss.clients) ws.terminate();
      server.close();
    });

    await waitFor(() => client.connected, "the retry to connect");
  }, 15_000);

  it("answers a relayed settings request with the sealed result", async () => {
    const port = await freePort();
    const server: Server = createServer();
    const wss = new WebSocketServer({ server });
    const answers: unknown[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => answers.push(JSON.parse(String(data))));
      ws.send(JSON.stringify({ type: "hello" }));
      ws.send(JSON.stringify({ type: "settings", requestId: "req-1", sealed: "ob1.request" }));
    });
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => {
      for (const ws of wss.clients) ws.terminate();
      server.close();
    });
    const client = new DaemonClient(
      config(port),
      () => undefined,
      async (requestId, sealed) => `answer to ${requestId}: ${sealed}`,
    );
    client.start();
    cleanup.push(() => client.stop());

    await waitFor(() => answers.length > 0, "the settings answer");
    expect(answers[0]).toEqual({
      type: "settings-result",
      requestId: "req-1",
      sealed: "answer to req-1: ob1.request",
    });
  });
});
