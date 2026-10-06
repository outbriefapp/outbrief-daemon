import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BriefSubmission } from "./brief/schema.ts";
import { generateKey, openJson, REPORT_AAD, sealJson } from "./e2e/crypto.ts";
import { startListener } from "./listener.ts";
import type { MulticaReportInput } from "./multica/ingest.ts";
import { Outbox, type OutboxOptions } from "./outbox.ts";
import { StateStore } from "./state.ts";

const dirs: string[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "outbrief-outbox-"));
  dirs.push(dir);
  return dir;
}

const READY: BriefSubmission = {
  status: "ready",
  brief: {
    verdict: { status: "done", headline: "登录页重构完成" },
    facts: [{ id: "f1", text: "登录页重构完成", importance: "critical" }],
    segments: [
      {
        id: "s1",
        speech: "做完了。",
        card: { title: "结果", bullets: [] },
        coveredFactIds: ["f1"],
      },
    ],
    decisions: [],
  },
  llmChannel: "primary",
  llmCalls: 1,
  rewritten: false,
  supplemented: false,
  error: null,
  generatedAt: "2026-09-28T00:00:00.000Z",
};

const MULTICA: MulticaReportInput = {
  title: "YOUT-7 修复登录跳转",
  content: "改好了",
  multica: {
    workspaceId: "ws-1",
    taskId: "task-1",
    issueId: "issue-1",
    issueIdentifier: "YOUT-7",
    issueTitle: "修复登录跳转",
    projectId: "proj-1",
    projectTitle: "outbrief",
    issuePriority: "high",
    issueUpdatedAt: "2026-09-26T10:06:00Z",
    agentId: "agent-1",
    agentName: "Mika",
    reportCommentId: "c1",
  },
};

/** The end-to-end key the test "devices" share. */
const KEY = generateKey();
const openReport = (sealed: unknown) => openJson(KEY, REPORT_AAD, String(sealed));

interface Posted {
  path: string;
  auth: string;
  body: Record<string, unknown>;
}

/** The server side: answers each POST with the next scripted response (default 201). */
function setup(options: Partial<OutboxOptions> & { responses?: (() => Response)[] } = {}) {
  const path = options.path ?? join(tempDir(), "outbox.json");
  const posted: Posted[] = [];
  const logs: string[] = [];
  const generated: string[] = [];
  const responses = options.responses ?? [];
  const make = (overrides: Partial<OutboxOptions> = {}) => {
    const outbox = new Outbox({
      serverUrl: "http://server.test",
      token: "obm_machine",
      path,
      log: (m) => logs.push(m),
      minBackoffMs: 5,
      maxBackoffMs: 20,
      seal: (report) => sealJson(KEY, REPORT_AAD, report),
      generate: async (report) => {
        generated.push(report.content);
        return READY;
      },
      fetch: async (input, init) => {
        posted.push({
          path: new URL(String(input)).pathname,
          auth: new Headers(init?.headers).get("Authorization") ?? "",
          body: JSON.parse(String(init?.body)),
        });
        const next = responses.shift();
        return next ? next() : Response.json({ id: "evt" }, { status: 201 });
      },
      ...options,
      ...overrides,
    });
    cleanup.push(() => outbox.close());
    return outbox;
  };
  const onDisk = () =>
    (JSON.parse(readFileSync(path, "utf8")) as { items: { brief: unknown }[] }).items;
  return { make, path, posted, logs, generated, onDisk };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (const started = Date.now(); !check(); ) {
    if (Date.now() - started > 3_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

describe("Outbox", () => {
  it("sends each report sealed with its brief to the matching server route", async () => {
    const { make, posted, onDisk, logs } = setup();
    const outbox = make();
    outbox.start();
    outbox.add({ kind: "event", input: { source: "codex", sessionId: "s1", content: "report" } });
    outbox.add({ kind: "multica", input: MULTICA });
    await waitFor(() => outbox.items.length === 0, "both reports sent");
    expect(posted.map((p) => [p.path, p.auth]).sort()).toEqual([
      ["/v1/daemon/events", "Bearer obm_machine"],
      ["/v1/daemon/multica-reports", "Bearer obm_machine"],
    ]);
    const brief = {
      status: "ready",
      brief: READY.brief,
      llmChannel: "primary",
      error: null,
      generatedAt: READY.generatedAt,
    };
    // Only the source (and the Multica task id, for one call per task) stays in the clear.
    const event = posted.find((p) => p.path === "/v1/daemon/events");
    expect(Object.keys(event?.body ?? {})).toEqual(["source", "sealed"]);
    expect(event?.body.source).toBe("codex");
    expect(openReport(event?.body.sealed)).toEqual({ sessionId: "s1", content: "report", brief });
    const multica = posted.find((p) => p.path === "/v1/daemon/multica-reports");
    expect(Object.keys(multica?.body ?? {})).toEqual(["taskId", "sealed"]);
    expect(multica?.body.taskId).toBe("task-1");
    const { taskId: _taskId, ...origin } = MULTICA.multica;
    expect(openReport(multica?.body.sealed)).toEqual({
      title: MULTICA.title,
      content: MULTICA.content,
      brief,
      multica: origin,
    });
    expect(JSON.stringify(posted)).not.toContain("改好了");
    expect(onDisk()).toEqual([]);
    expect(logs.some((l) => l.includes("YOUT-7 report from Mika: sent as a call"))).toBe(true);
  });

  it("persists a report, readable by this user only, before add returns", () => {
    const { make, path, onDisk } = setup();
    // Not started: nothing is processed, so the file shows exactly what add() wrote.
    make().add({ kind: "event", input: { source: "codex", content: "report" } });
    expect(onDisk()).toMatchObject([
      { kind: "event", input: { content: "report" }, brief: null, attempts: 0 },
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("resumes pending reports after a restart", async () => {
    const { make, posted, generated } = setup();
    make().add({ kind: "event", input: { source: "codex", content: "before restart" } });

    const restarted = make();
    restarted.start();
    await waitFor(() => posted.length === 1, "the resumed report");
    expect(generated).toEqual(["before restart"]);
    expect(restarted.items).toEqual([]);
  });

  it("retries network errors, 5xx and 429 with backoff, then delivers", async () => {
    const { make, posted, logs } = setup({
      responses: [
        () => {
          throw new TypeError("fetch failed");
        },
        () => new Response("bad gateway", { status: 502 }),
        () => Response.json({ error: "slow down" }, { status: 429 }),
      ],
    });
    const outbox = make();
    outbox.start();
    outbox.add({ kind: "event", input: { source: "codex", content: "report" } });
    await waitFor(() => outbox.items.length === 0, "delivery after retries");
    expect(posted).toHaveLength(4);
    expect(logs.filter((l) => l.includes("retry"))).toHaveLength(3);
  });

  it("does not regenerate the brief after a failed POST, even across a restart", async () => {
    const { make, posted, generated, onDisk } = setup({
      responses: [() => new Response("down", { status: 503 })],
      minBackoffMs: 60_000,
    });
    const first = make();
    first.start();
    first.add({ kind: "event", input: { source: "codex", content: "report" } });
    await waitFor(() => posted.length === 1, "the first POST");
    await first.idle();
    expect(onDisk()).toMatchObject([{ brief: READY, attempts: 1, lastError: "503 down" }]);
    await first.close();

    const restarted = make();
    restarted.start();
    await waitFor(() => restarted.items.length === 0, "delivery after restart");
    expect(generated).toEqual(["report"]);
    expect(posted.map((p) => (openReport(p.body.sealed) as { brief: unknown }).brief)).toEqual([
      expect.objectContaining({ brief: READY.brief }),
      expect.objectContaining({ brief: READY.brief }),
    ]);
  });

  it("drops a report the server refuses with another 4xx", async () => {
    const { make, posted, logs } = setup({
      responses: [() => Response.json({ error: "invalid_event" }, { status: 400 })],
    });
    const outbox = make();
    outbox.start();
    outbox.add({ kind: "event", input: { source: "codex", content: "report" } });
    await waitFor(() => outbox.items.length === 0, "the drop");
    expect(posted).toHaveLength(1);
    expect(logs.some((l) => l.includes("dropped, server refused it (400"))).toBe(true);
  });

  it("treats 409 duplicate_task as done", async () => {
    const { make, posted, logs } = setup({
      responses: [() => Response.json({ error: "duplicate_task" }, { status: 409 })],
    });
    const outbox = make();
    outbox.start();
    outbox.add({ kind: "multica", input: MULTICA });
    await waitFor(() => outbox.items.length === 0, "the duplicate");
    expect(posted).toHaveLength(1);
    expect(logs.some((l) => l.includes("task task-1 already has a call"))).toBe(true);
  });

  it("queues a Multica task only once", () => {
    const { make } = setup();
    const outbox = make();
    expect(outbox.add({ kind: "multica", input: MULTICA })).not.toBeNull();
    expect(outbox.add({ kind: "multica", input: MULTICA })).toBeNull();
    expect(outbox.items).toHaveLength(1);
  });

  it("generates at most 3 briefs at once, started in arrival order", async () => {
    const gates: (() => void)[] = [];
    const started: string[] = [];
    const { make } = setup({
      generate: (report) => {
        started.push(report.content);
        return new Promise((resolve) => gates.push(() => resolve(READY)));
      },
    });
    const outbox = make();
    outbox.start();
    for (const n of [1, 2, 3, 4, 5]) {
      outbox.add({ kind: "event", input: { source: "codex", content: `r${n}` } });
    }
    await waitFor(() => started.length === 3, "three generations");
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(["r1", "r2", "r3"]);
    gates.shift()?.();
    await waitFor(() => started.length === 4, "the fourth generation");
    expect(started).toEqual(["r1", "r2", "r3", "r4"]);
    for (const gate of gates.splice(0)) gate();
    await waitFor(() => started.length === 5, "the fifth generation");
    for (const gate of gates.splice(0)) gate();
    await waitFor(() => outbox.items.length === 0, "all sent");
  });

  it("aborts generation on close and keeps the report for the next start", async () => {
    let aborted = false;
    const { make, onDisk, posted } = setup({
      generate: (_report, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          });
        }),
    });
    const outbox = make();
    outbox.start();
    outbox.add({ kind: "event", input: { source: "codex", content: "report" } });
    await outbox.close();
    expect(aborted).toBe(true);
    expect(posted).toEqual([]);
    expect(onDisk()).toMatchObject([{ input: { content: "report" }, brief: null }]);
  });

  it("moves an unreadable outbox aside instead of emptying it silently", () => {
    const { make, path, logs } = setup();
    writeFileSync(path, "{not json");
    expect(make().items).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(path, "..")).some((f) => f.startsWith("outbox.json.corrupt-"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("not valid JSON"))).toBe(true);
  });
});

describe("POST /report", () => {
  it("answers 202 once the report is on disk, before any brief exists", async () => {
    const { make, onDisk } = setup();
    const outbox = make(); // not started: the brief cannot have been generated
    const state = new StateStore(join(tempDir(), "state.json"));
    const port = await freePort();
    const listener = startListener({ localPort: port }, state, outbox, () => undefined);
    cleanup.push(() => listener.close());
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(`http://127.0.0.1:${port}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "claude-code",
        sessionId: "s1",
        cwd: "/srv/app",
        content: "done",
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(onDisk()).toMatchObject([{ input: { sessionId: "s1", content: "done" }, brief: null }]);
    expect(state.session("s1")).toMatchObject({ agent: "claude-code", cwd: "/srv/app" });

    const invalid = await fetch(`http://127.0.0.1:${port}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "multica", content: "x" }),
    });
    expect(invalid.status).toBe(400);
    expect(onDisk()).toHaveLength(1);
  });

  it("?dryRun=1 validates and echoes the report without queuing it, so it never rings", async () => {
    const { make, path } = setup();
    const outbox = make();
    const state = new StateStore(join(tempDir(), "state.json"));
    const port = await freePort();
    const listener = startListener({ localPort: port }, state, outbox, () => undefined);
    cleanup.push(() => listener.close());
    await new Promise((r) => setTimeout(r, 20));

    const event = { source: "claude-code", sessionId: "s1", cwd: "/srv/app", content: "done" };
    const res = await fetch(`http://127.0.0.1:${port}/report?dryRun=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: true, event });
    expect(existsSync(path)).toBe(false);
    expect(outbox.items).toEqual([]);
    expect(state.session("s1")).toBeUndefined();

    const invalid = await fetch(`http://127.0.0.1:${port}/report?dryRun=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "multica", content: "x" }),
    });
    expect(invalid.status).toBe(400);
  });
});
