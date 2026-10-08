import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MulticaClient } from "./client.ts";
import { DispatchError, Dispatcher, DispatchStore } from "./dispatch.ts";

interface FakeTask {
  id: string;
  status: string;
  issue_id?: string;
  error?: string | null;
  completed_at?: string | null;
}

/** A fake Multica REST API: answers the few paths the dispatcher reads and writes. */
function fakeMultica() {
  const state = {
    tasks: [] as FakeTask[],
    issues: new Map<string, Record<string, unknown>>(),
    posted: [] as { path: string; body: unknown }[],
    uploads: [] as { name: string; type: string; bytes: number }[],
    listed: [] as string[],
    refuse: null as { status: number; body: unknown } | null,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    const path = url.pathname;
    if (init?.method === "POST" && path === "/api/upload-file") {
      const file = (init.body as FormData).get("file") as File;
      state.uploads.push({ name: file.name, type: file.type, bytes: file.size });
      const id = `att-${state.uploads.length}`;
      return json({
        id,
        filename: file.name,
        markdown_url: `https://api.multica.test/api/attachments/${id}/download`,
      });
    }
    if (init?.method === "POST") {
      state.posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/issues/quick-create") {
        if (state.refuse) return json(state.refuse.body, state.refuse.status);
        return json({ task_id: "task-1" }, 202);
      }
      if (path === "/api/issues/i1/comments") {
        return json({
          id: "c-9",
          author_type: "member",
          content: "x",
          created_at: "2026-09-30T10:00:00Z",
        });
      }
      if (path === "/api/tasks/task-1/cancel") return json({ id: "task-1", status: "cancelled" });
    }
    if (path === "/api/projects") {
      return json({
        projects: [
          { id: "p1", title: "outbrief", status: "in_progress" },
          { id: "p2", title: "old", status: "completed" },
        ],
      });
    }
    if (path === "/api/issues" && init?.method === "GET") {
      state.listed.push(url.search);
      return json({ issues: [ISSUE], total: 1 });
    }
    if (path === "/api/issue-statuses") {
      return json({
        statuses: [
          { key: "backlog", name: "Backlog", archived_at: null },
          { key: "qa", name: "QA", archived_at: null },
          { key: "old", name: "Old", archived_at: "2026-09-01T00:00:00Z" },
        ],
      });
    }
    if (path === "/api/projects/p1") return json({ id: "p1", title: "outbrief" });
    if (path === "/api/agents") {
      return json([
        { id: "a1", name: "资深架构师", description: "设计", runtime_id: "r1" },
        { id: "a2", name: "页面工程师", description: null, runtime_id: "r2" },
      ]);
    }
    if (path === "/api/agents/a1") return json({ id: "a1", name: "资深架构师" });
    if (path === "/api/agents/nope") return json({ error: "agent not found" }, 404);
    if (path === "/api/runtimes") {
      return json([
        { id: "r1", name: "Claude", status: "online" },
        { id: "r2", name: "Codex", status: "offline" },
      ]);
    }
    if (path === "/api/agents/a1/tasks") return json(state.tasks);
    const issue = state.issues.get(path);
    if (issue) return json(issue);
    return json({ error: "not found" }, 404);
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
}

function setup(now = new Date("2026-09-30T10:00:00Z")) {
  const fake = fakeMultica();
  const clock = { now };
  const store = new DispatchStore(join(mkdtempSync(join(tmpdir(), "dispatch-")), "d.json"));
  const dispatcher = new Dispatcher({
    client: (workspaceId) =>
      new MulticaClient(
        { apiUrl: "https://api.multica.test", token: "mul_x", workspaceId: workspaceId ?? "ws" },
        fake.fetchImpl,
      ),
    store,
    now: () => clock.now,
  });
  return { ...fake, clock, store, dispatcher };
}

const ISSUE = {
  id: "i1",
  identifier: "YOUT-230",
  title: "来电页按项目一键知悉",
  priority: "high",
  status: "todo",
  project_id: "p1",
  updated_at: "2026-09-30T10:01:00Z",
};

describe("Dispatcher", () => {
  it("lists open projects and whether each agent's machine is online", async () => {
    const { dispatcher } = setup();
    expect(await dispatcher.options()).toEqual({
      projects: [{ id: "p1", title: "outbrief" }],
      agents: [
        { id: "a1", name: "资深架构师", description: "设计", online: true },
        { id: "a2", name: "页面工程师", description: "", online: false },
      ],
    });
  });

  it("asks Multica's smart create for the issue, then follows the task to it", async () => {
    const { dispatcher, state, store } = setup();
    const created = await dispatcher.create({
      projectId: "p1",
      agentId: "a1",
      prompt: "  加一个按项目一键知悉，优先级高  ",
    });
    expect(state.posted).toEqual([
      {
        path: "/api/issues/quick-create",
        body: { agent_id: "a1", project_id: "p1", prompt: "加一个按项目一键知悉，优先级高" },
      },
    ]);
    expect(created).toMatchObject({
      id: "task-1",
      projectTitle: "outbrief",
      agentName: "资深架构师",
      state: "creating",
      issue: null,
    });

    state.tasks = [{ id: "task-1", status: "running" }];
    expect((await dispatcher.lookup("task-1")).state).toBe("creating");

    state.tasks = [{ id: "task-1", status: "completed", issue_id: "i1" }];
    state.issues.set("/api/issues/i1", ISSUE);
    expect(await dispatcher.lookup("task-1")).toMatchObject({
      state: "created",
      issue: { id: "i1", identifier: "YOUT-230", title: ISSUE.title, status: "todo" },
    });

    // Later reads follow the issue itself.
    state.issues.set("/api/issues/i1", { ...ISSUE, status: "in_review" });
    expect((await dispatcher.list())[0]?.issue?.status).toBe("in_review");
    expect(store.list()).toHaveLength(1);
  });

  it("uploads each image, then puts them in the request as markdown", async () => {
    const { dispatcher, state } = setup();
    const png = Buffer.from("fake png bytes");
    const first = await dispatcher.upload({
      name: "shot [1].png",
      type: "image/png",
      data: png.toString("base64"),
    });
    const second = await dispatcher.upload({
      name: "",
      type: "image/jpeg",
      data: png.toString("base64"),
    });
    expect(state.uploads).toEqual([
      { name: "shot [1].png", type: "image/png", bytes: png.length },
      { name: "image", type: "image/jpeg", bytes: png.length },
    ]);
    expect(first).toEqual({
      id: "att-1",
      filename: "shot [1].png",
      markdownUrl: "https://api.multica.test/api/attachments/att-1/download",
    });
    const created = await dispatcher.create({
      projectId: "p1",
      agentId: "a1",
      prompt: "按截图改",
      attachments: [first, second],
    });
    expect(state.posted).toEqual([
      {
        path: "/api/issues/quick-create",
        body: {
          agent_id: "a1",
          project_id: "p1",
          prompt:
            "按截图改\n\n![shot  1 .png](https://api.multica.test/api/attachments/att-1/download)" +
            "\n\n![image](https://api.multica.test/api/attachments/att-2/download)",
          attachment_ids: ["att-1", "att-2"],
        },
      },
    ]);
    // 我的派单 shows what was said and how many images went with it.
    expect(created).toMatchObject({ prompt: "按截图改", images: 2 });
  });

  it("takes any number of images, even alone, but only images up to Multica's 100 MB", async () => {
    const { dispatcher, state } = setup();
    const data = Buffer.from("x").toString("base64");
    const attachments = [];
    for (let i = 0; i < 12; i++) {
      attachments.push(await dispatcher.upload({ name: `${i}.png`, type: "image/png", data }));
    }
    await dispatcher.create({ projectId: "p1", agentId: "a1", prompt: " ", attachments });
    expect(state.posted[0]?.body).toMatchObject({
      attachment_ids: attachments.map((a) => a.id),
    });
    await expect(
      dispatcher.upload({ name: "a.pdf", type: "application/pdf", data }),
    ).rejects.toMatchObject({ code: "invalid_dispatch" });
    const big = Buffer.alloc(100 * 1024 * 1024 + 1).toString("base64");
    await expect(
      dispatcher.upload({ name: "big.png", type: "image/png", data: big }),
    ).rejects.toMatchObject({ code: "invalid_dispatch" });
    expect(state.uploads).toHaveLength(12);
    // An attachment whose link would break the request's markdown is refused.
    await expect(
      dispatcher.create({
        projectId: "p1",
        agentId: "a1",
        prompt: "x",
        attachments: [{ id: "a", filename: "a", markdownUrl: "https://x/a) b" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_dispatch" });
  });

  it("says why when the agent created no issue", async () => {
    const { dispatcher, state, clock } = setup();
    await dispatcher.create({ projectId: "p1", agentId: "a1", prompt: "x" });
    state.tasks = [{ id: "task-1", status: "completed", completed_at: "2026-09-30T10:00:30Z" }];
    clock.now = new Date("2026-09-30T10:01:00Z");
    // Multica links the issue just after completion: wait a little first.
    expect((await dispatcher.lookup("task-1")).state).toBe("creating");
    clock.now = new Date("2026-09-30T10:02:00Z");
    expect(await dispatcher.lookup("task-1")).toMatchObject({
      state: "failed",
      error: "no_issue_created",
    });
  });

  it("records a failed task with Multica's reason", async () => {
    const { dispatcher, state } = setup();
    await dispatcher.create({ projectId: "p1", agentId: "a1", prompt: "x" });
    state.tasks = [{ id: "task-1", status: "failed", error: "duplicate issue" }];
    expect(await dispatcher.lookup("task-1")).toMatchObject({
      state: "failed",
      error: "duplicate issue",
    });
  });

  it("cancels a dispatch still being created", async () => {
    const { dispatcher, state } = setup();
    await dispatcher.create({ projectId: "p1", agentId: "a1", prompt: "x" });
    state.tasks = [{ id: "task-1", status: "queued" }];
    expect((await dispatcher.cancel("task-1")).state).toBe("cancelled");
    expect(state.posted.map((p) => p.path)).toContain("/api/tasks/task-1/cancel");
  });

  it("turns Multica's refusals into errors the app can explain", async () => {
    const { dispatcher, state } = setup();
    state.refuse = {
      status: 422,
      body: { code: "agent_unavailable", reason: "runtime is offline" },
    };
    const refused = await dispatcher
      .create({ projectId: "p1", agentId: "a1", prompt: "x" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DispatchError);
    expect(refused).toMatchObject({ code: "agent_unavailable", message: "runtime is offline" });

    await expect(
      dispatcher.create({ projectId: "p1", agentId: "nope", prompt: "x" }),
    ).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(
      dispatcher.create({ projectId: "p1", agentId: "a1", prompt: "   " }),
    ).rejects.toMatchObject({ code: "invalid_dispatch" });
  });

  it("lists the project's issues, most recently active first, to pick one (OUTB-61)", async () => {
    const { dispatcher, state } = setup();
    expect(await dispatcher.issues({ projectId: "p1", query: "知悉" })).toEqual([
      {
        id: "i1",
        identifier: "YOUT-230",
        title: "来电页按项目一键知悉",
        status: "todo",
        priority: "high",
      },
    ]);
    expect(Object.fromEntries(new URLSearchParams(state.listed[0]))).toEqual({
      project_id: "p1",
      sort: "last_activity",
      limit: "50",
      q: "知悉",
    });
  });

  it("filters the issues by several statuses at once, from the workspace's catalog", async () => {
    const { dispatcher, state } = setup();
    await dispatcher.issues({ projectId: "p1", statuses: ["backlog", "in_progress"] });
    expect(new URLSearchParams(state.listed[0]).get("statuses")).toBe("backlog,in_progress");
    // Custom statuses are offered too; archived ones are not.
    expect(await dispatcher.statuses()).toEqual([
      { key: "backlog", name: "Backlog" },
      { key: "qa", name: "QA" },
    ]);
  });

  it("comments on the picked issue instead of creating one (OUTB-61)", async () => {
    const { dispatcher, state, store } = setup();
    state.issues.set("/api/issues/i1", { ...ISSUE, assignee_type: "agent", assignee_id: "a1" });
    const dispatch = await dispatcher.create({
      issueId: "i1",
      prompt: "  顺便把未接来电也算上  ",
      attachments: [{ id: "att-1", filename: "shot.png", markdownUrl: "https://m.test/att-1" }],
    });
    expect(state.posted).toEqual([
      {
        path: "/api/issues/i1/comments",
        body: {
          content: "顺便把未接来电也算上\n\n![shot.png](https://m.test/att-1)",
          attachment_ids: ["att-1"],
        },
      },
    ]);
    expect(dispatch).toMatchObject({
      id: "c-9",
      kind: "comment",
      state: "created",
      projectTitle: "outbrief",
      agentId: "a1",
      agentName: "资深架构师",
      prompt: "顺便把未接来电也算上",
      images: 1,
      issue: { id: "i1", identifier: "YOUT-230" },
    });
    expect(store.get("c-9")).toEqual(dispatch);
    // Nothing to wait for or cancel: the comment is already posted.
    expect((await dispatcher.cancel("c-9")).state).toBe("created");
  });

  it("refuses a comment on an issue that is gone", async () => {
    const { dispatcher, state } = setup();
    await expect(dispatcher.create({ issueId: "gone", prompt: "x" })).rejects.toMatchObject({
      code: "issue_not_found",
    });
    expect(state.posted).toEqual([]);
  });
});
