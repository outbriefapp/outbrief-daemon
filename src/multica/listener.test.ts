import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as ServerSocket, WebSocketServer } from "ws";
import { type CompletedTask, MulticaListener } from "./listener.ts";

const WORKSPACE = "ws-1";
const TOKEN = "mul_test_token";

interface Connection {
  socket: ServerSocket;
  url: string;
  firstFrame: unknown;
}

/** A stand-in for Multica's `/ws`: hands out each connection once its first frame arrived. */
async function fakeMultica() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const ready: Connection[] = [];
  const waiting: ((c: Connection) => void)[] = [];
  server.on("connection", (socket, req) => {
    socket.once("message", (data) => {
      const conn = { socket, url: req.url ?? "", firstFrame: JSON.parse(String(data)) };
      const waiter = waiting.shift();
      if (waiter) waiter(conn);
      else ready.push(conn);
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    apiUrl: `http://127.0.0.1:${port}`,
    next: () =>
      new Promise<Connection>((resolve) => {
        const conn = ready.shift();
        if (conn) resolve(conn);
        else waiting.push(resolve);
      }),
  };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > 3_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function send(conn: Connection, frame: unknown): void {
  conn.socket.send(JSON.stringify(frame));
}

function taskCompleted(taskId: string, extra: Record<string, unknown> = {}) {
  return {
    type: "task:completed",
    payload: {
      task_id: taskId,
      agent_id: "agent-1",
      issue_id: `issue-${taskId}`,
      status: "completed",
      ...extra,
    },
    actor_id: "",
    actor_type: "system",
  };
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function setup(onTaskCompleted: (task: CompletedTask) => Promise<void>) {
  const fake = await fakeMultica();
  const logs: string[] = [];
  const listener = new MulticaListener({
    config: { apiUrl: fake.apiUrl, workspaceId: WORKSPACE, token: TOKEN },
    onTaskCompleted,
    log: (m) => logs.push(m),
    minBackoffMs: 10,
    maxBackoffMs: 40,
    handshakeTimeoutMs: 100,
  });
  cleanup.push(async () => {
    await listener.stop();
    for (const client of fake.server.clients) client.terminate();
    await new Promise((r) => fake.server.close(r));
  });
  listener.start();
  return { fake, listener, logs };
}

describe("MulticaListener", () => {
  it("authenticates with the PAT in the first frame and hands over issue tasks one at a time", async () => {
    const handled: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const { fake, listener } = await setup(async (task) => {
      handled.push(`start ${task.taskId} ${task.issueId} ${task.agentId}`);
      if (task.taskId === "t1") await firstGate;
      handled.push(`end ${task.taskId}`);
    });

    const conn = await fake.next();
    expect(conn.url).toBe(`/ws?workspace_id=${WORKSPACE}&client_platform=outbrief-daemon`);
    expect(conn.firstFrame).toEqual({ type: "auth", payload: { token: TOKEN } });
    expect(listener.connected).toBe(false);
    send(conn, { type: "auth_ack" });
    await waitFor(() => listener.connected, "auth_ack");
    expect(listener.error).toBeNull();

    send(conn, taskCompleted("chat", { chat_session_id: "chat-1" }));
    send(conn, taskCompleted("no-issue", { issue_id: null }));
    send(conn, { type: "issue:updated", payload: { id: "issue-x" } });
    send(conn, taskCompleted("t1"));
    send(conn, taskCompleted("t2"));
    await waitFor(() => handled.length === 1, "first task to start");
    await new Promise((r) => setTimeout(r, 30));
    expect(handled).toEqual(["start t1 issue-t1 agent-1"]);
    releaseFirst();
    await waitFor(() => handled.length === 4, "both tasks");
    expect(handled).toEqual([
      "start t1 issue-t1 agent-1",
      "end t1",
      "start t2 issue-t2 agent-1",
      "end t2",
    ]);
  });

  it("reports a rejected PAT, keeps retrying, and clears the error once accepted", async () => {
    const { fake, listener } = await setup(async () => undefined);

    const rejected = await fake.next();
    send(rejected, { error: "invalid token" });
    rejected.socket.close(4001, "unauthorized");
    await waitFor(() => listener.error?.includes("invalid token") === true, "rejection");
    expect(listener.error).toContain("Multica 拒绝连接：invalid token");
    expect(listener.connected).toBe(false);

    const retry = await fake.next();
    expect(retry.firstFrame).toEqual({ type: "auth", payload: { token: TOKEN } });
    send(retry, { type: "auth_ack" });
    await waitFor(() => listener.connected, "reconnect");
    expect(listener.error).toBeNull();
  });

  it("reconnects after a dropped connection and reports a task that could not become a call", async () => {
    const { fake, listener } = await setup(async (task) => {
      throw new Error(`issue ${task.issueId} is gone`);
    });

    const first = await fake.next();
    send(first, { type: "auth_ack" });
    await waitFor(() => listener.connected, "first auth");
    first.socket.terminate();
    await waitFor(() => !listener.connected, "drop");
    expect(listener.error).toContain("Multica 连接断开");

    const second = await fake.next();
    send(second, { type: "auth_ack" });
    await waitFor(() => listener.connected, "second auth");
    expect(listener.error).toBeNull();

    send(second, taskCompleted("t9"));
    await waitFor(() => listener.error !== null, "task failure");
    expect(listener.error).toBe("Multica 任务 t9 没能转成来电：issue issue-t9 is gone");
  });

  it("gives up on a connection that is never acknowledged and connects again", async () => {
    const { fake, listener, logs } = await setup(async () => undefined);
    const silent = await fake.next();
    const abandoned = once(silent.socket, "close");
    const retry = await fake.next();
    await abandoned;
    expect(logs).toContain("Multica: no answer within 100 ms; reconnecting in 10 ms");
    expect(listener.error).toContain("Multica 没有响应");
    send(retry, { type: "auth_ack" });
    await waitFor(() => listener.connected, "auth after the retry");
    expect(listener.error).toBeNull();
  });

  it("gives up on a handshake that never completes (YOUT-228: silent for two hours)", async () => {
    // Takes the TCP connection and never answers the WebSocket upgrade.
    const sockets: Socket[] = [];
    const tcp = createServer((socket) => sockets.push(socket));
    await once(tcp.listen(0, "127.0.0.1"), "listening");
    const { port } = tcp.address() as AddressInfo;
    const logs: string[] = [];
    const listener = new MulticaListener({
      config: { apiUrl: `http://127.0.0.1:${port}`, workspaceId: WORKSPACE, token: TOKEN },
      onTaskCompleted: async () => undefined,
      log: (m) => logs.push(m),
      minBackoffMs: 10,
      maxBackoffMs: 40,
      handshakeTimeoutMs: 100,
    });
    cleanup.push(async () => {
      await listener.stop();
      for (const s of sockets) s.destroy();
      await new Promise((r) => tcp.close(r));
    });
    listener.start();
    await waitFor(() => sockets.length >= 2, "a second attempt");
    expect(logs[0]).toBe("Multica: no answer within 100 ms; reconnecting in 10 ms");
    expect(listener.connected).toBe(false);
  });

  it("answers the server's pings so Multica keeps the connection open", async () => {
    const { fake, listener } = await setup(async () => undefined);
    const conn = await fake.next();
    send(conn, { type: "auth_ack" });
    await waitFor(() => listener.connected, "auth");
    const pong = once(conn.socket, "pong");
    conn.socket.ping();
    await pong;
  });

  it("stop() closes the connection and does not reconnect", async () => {
    const { fake, listener } = await setup(async () => undefined);
    const conn = await fake.next();
    send(conn, { type: "auth_ack" });
    await waitFor(() => listener.connected, "auth");
    const closed = once(conn.socket, "close");
    await listener.stop();
    await closed;
    expect(listener.connected).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.server.clients.size).toBe(0);
  });
});
