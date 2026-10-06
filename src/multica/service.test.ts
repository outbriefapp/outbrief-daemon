import { describe, expect, it } from "vitest";
import type { DaemonConfig } from "../config.ts";
import type { MulticaReportInput } from "./ingest.ts";
import { MulticaService, MulticaSettingsError, type RunningListener } from "./service.ts";

const GOOD = "mul_good_token_9f3a";

function baseConfig(): DaemonConfig {
  return {
    serverUrl: "http://server.test",
    token: "obm_machine",
    machineId: "m1",
    machineName: "mac",
    localPort: 8790,
    claude: { permissionMode: "acceptEdits", addDirs: [] },
    codex: { sandbox: "workspace-write" },
  };
}

function setup(config = baseConfig()) {
  const saved: DaemonConfig[] = [];
  const listeners: (RunningListener & { token: string; workspaceId: string; stopped: boolean })[] =
    [];
  const onTask: ((task: { taskId: string; issueId: string; agentId: string }) => Promise<void>)[] =
    [];
  const reports: MulticaReportInput[] = [];
  const posted: { url: string; auth: string; body: unknown }[] = [];
  const requests: { path: string; workspace: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    requests.push({
      path: url.pathname,
      workspace: new Headers(init?.headers).get("X-Workspace-ID"),
    });
    if (url.pathname === "/api/workspaces") {
      if (auth !== `Bearer ${GOOD}`) return new Response("{}", { status: 401 });
      return Response.json([
        { id: "ws-1", name: "youtube-dubbing", slug: "youtube-dubbing" },
        { id: "ws-2", name: "side", slug: "side" },
      ]);
    }
    if (url.pathname === "/api/issues/issue-1") {
      return Response.json({
        id: "issue-1",
        identifier: "YOUT-7",
        title: "修复登录跳转",
        priority: "high",
        project_id: "proj-1",
        updated_at: "2026-09-28T01:00:00Z",
      });
    }
    if (url.pathname === "/api/issues/issue-2") {
      return Response.json({
        id: "issue-2",
        identifier: "YOUT-8",
        title: "没有项目",
        priority: "none",
        project_id: null,
        updated_at: "2026-09-28T02:00:00Z",
      });
    }
    if (url.pathname === "/api/issues/issue-3") {
      return Response.json({
        id: "issue-3",
        identifier: "YOUT-9",
        title: "同一个项目",
        priority: "urgent",
        project_id: "proj-1",
        updated_at: "2026-09-28T03:00:00Z",
      });
    }
    if (url.pathname === "/api/issues/boom") return new Response("oops", { status: 500 });
    if (url.pathname === "/api/projects/proj-1") {
      return Response.json({ id: "proj-1", title: "outbrief" });
    }
    if (url.pathname === "/api/agents/agent-1")
      return Response.json({ id: "agent-1", name: "Mika" });
    if (url.pathname === "/api/issues/issue-1/comments" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { content: string; parent_id: string };
      posted.push({ url: url.pathname, auth, body });
      return Response.json({
        id: "reply-1",
        author_type: "member",
        content: body.content,
        created_at: new Date().toISOString(),
      });
    }
    if (url.pathname === "/api/issues/issue-1/comments") {
      return Response.json([
        {
          id: "c1",
          author_type: "agent",
          content: "改好了",
          created_at: "2026-09-28T00:00:00Z",
          source_task_id: "task-1",
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  };
  const service = new MulticaService({
    config,
    save: (c) => saved.push(structuredClone(c)),
    enqueueReport: (report) => {
      reports.push(report);
      return true;
    },
    apiUrl: "https://multica.test",
    log: () => undefined,
    fetch: fetchImpl,
    retryDelaysMs: [1],
    listen: (cfg, handler) => {
      const listener = {
        token: cfg.token,
        workspaceId: cfg.workspaceId,
        stopped: false,
        connected: true,
        error: null,
        async stop() {
          listener.stopped = true;
        },
      };
      listeners.push(listener);
      onTask.push(handler);
      return listener;
    },
  });
  return { service, config, saved, listeners, onTask, reports, posted, requests };
}

describe("MulticaService", () => {
  it("starts empty: no token, no connection", () => {
    const { service, listeners } = setup();
    service.start();
    expect(listeners).toHaveLength(0);
    expect(service.view()).toEqual({
      settings: null,
      status: { configured: false, connected: false, error: null, workspaces: [] },
    });
  });

  it("checks the token, saves it only on this machine, and shows just a hint", async () => {
    const { service, saved, listeners } = setup();
    await expect(service.listWorkspaces("mul_wrong")).rejects.toBeInstanceOf(MulticaSettingsError);
    await expect(service.save(GOOD, ["ws-1", "ws-9"])).rejects.toMatchObject({
      code: "workspace_not_found",
    });
    await expect(service.save(GOOD, [])).rejects.toMatchObject({ code: "workspace_not_found" });
    expect(saved).toHaveLength(0);

    const view = await service.save(GOOD, ["ws-2"]);
    expect(view.settings).toMatchObject({
      workspaces: [{ id: "ws-2", name: "side" }],
      workspaceId: "ws-2",
      workspaceName: "side",
      tokenHint: "mul_…9f3a",
    });
    expect(JSON.stringify(view)).not.toContain(GOOD);
    expect(saved.at(-1)?.multica).toMatchObject({
      token: GOOD,
      workspaces: [{ id: "ws-2", name: "side" }],
    });
    expect(listeners.map((l) => [l.workspaceId, l.stopped])).toEqual([["ws-2", false]]);

    await service.save(GOOD, ["ws-1"]);
    expect(listeners.map((l) => [l.workspaceId, l.stopped])).toEqual([
      ["ws-2", true],
      ["ws-1", false],
    ]);

    await service.remove();
    expect(saved.at(-1)?.multica).toBeUndefined();
    expect(listeners[1]?.stopped).toBe(true);
    expect(service.view().settings).toBeNull();
  });

  it("reconnects with the saved token on start", () => {
    const config = baseConfig();
    config.multica = {
      token: GOOD,
      workspaces: [{ id: "ws-1", name: "youtube-dubbing" }],
      updatedAt: "2026-09-28T00:00:00Z",
    };
    const { service, listeners } = setup(config);
    service.start();
    expect(listeners).toMatchObject([{ token: GOOD, workspaceId: "ws-1" }]);
    expect(service.status()).toEqual({
      configured: true,
      connected: true,
      error: null,
      workspaces: [
        { workspaceId: "ws-1", workspaceName: "youtube-dubbing", connected: true, error: null },
      ],
    });
  });

  it("listens to every chosen workspace, each on its own connection", async () => {
    const { service, saved, listeners, onTask, reports } = setup();
    const view = await service.save(GOOD, ["ws-1", "ws-2", "ws-1"]);
    expect(view.settings).toMatchObject({
      workspaces: [
        { id: "ws-1", name: "youtube-dubbing" },
        { id: "ws-2", name: "side" },
      ],
      workspaceId: "ws-1",
      workspaceName: "youtube-dubbing, side",
    });
    expect(saved.at(-1)?.multica?.workspaces.map((w) => w.id)).toEqual(["ws-1", "ws-2"]);
    expect(listeners.map((l) => l.workspaceId)).toEqual(["ws-1", "ws-2"]);

    // One connection down: the status says which workspace.
    Object.assign(listeners[1] as object, { connected: false, error: "Multica 拒绝了令牌" });
    expect(service.status()).toMatchObject({
      configured: true,
      connected: false,
      error: "side: Multica 拒绝了令牌",
      workspaces: [
        { workspaceId: "ws-1", connected: true, error: null },
        { workspaceId: "ws-2", workspaceName: "side", connected: false },
      ],
    });

    // A task finished in the second workspace is read there and says so.
    await onTask[1]?.({ taskId: "task-1", issueId: "issue-1", agentId: "agent-1" });
    expect(reports[0]?.multica).toMatchObject({ workspaceId: "ws-2", workspaceName: "side" });

    // The app dispatches to the first workspace by default.
    expect(service.client().config.workspaceId).toBe("ws-1");
    expect(service.client("ws-2").config.workspaceId).toBe("ws-2");

    await service.save(GOOD, ["ws-2"]);
    expect(listeners.map((l) => l.stopped)).toEqual([true, true, false]);
  });

  it("queues finished tasks for the server and posts replies as the user", async () => {
    const { service, onTask, reports, posted } = setup();
    await service.save(GOOD, ["ws-1"]);
    await onTask[0]?.({ taskId: "task-1", issueId: "issue-1", agentId: "agent-1" });
    expect(reports).toMatchObject([
      {
        title: "YOUT-7 修复登录跳转",
        content: "改好了",
        multica: {
          workspaceId: "ws-1",
          workspaceName: "youtube-dubbing",
          taskId: "task-1",
          reportCommentId: "c1",
          projectTitle: "outbrief",
          issuePriority: "high",
        },
      },
    ]);

    const commentId = await service.postReply(
      { workspaceId: "ws-1", issueId: "issue-1", reportCommentId: "c1" },
      "删掉旧接口",
    );
    expect(commentId).toBe("reply-1");
    expect(posted).toEqual([
      {
        url: "/api/issues/issue-1/comments",
        auth: `Bearer ${GOOD}`,
        body: { content: "删掉旧接口", parent_id: "c1" },
      },
    ]);
  });

  it("refuses to post a reply without a token", async () => {
    const { service } = setup();
    await expect(
      service.postReply({ workspaceId: "ws-1", issueId: "issue-1", reportCommentId: "c1" }, "x"),
    ).rejects.toThrow("没有设置 Multica API Token");
  });

  it("reads past calls' issues as they are now, in each report's workspace", async () => {
    const { service, requests } = setup();
    await expect(service.issues([])).rejects.toMatchObject({ code: "multica_not_configured" });
    await service.save(GOOD, ["ws-1"]);
    requests.length = 0;
    const issues = await service.issues([
      { workspaceId: "ws-1", issueId: "issue-1" },
      { workspaceId: "ws-1", issueId: "gone" },
      { workspaceId: "ws-2", issueId: "issue-2" },
      { workspaceId: "ws-1", issueId: "issue-3" },
    ]);
    expect(issues).toEqual([
      {
        workspaceId: "ws-1",
        issueId: "issue-1",
        issueIdentifier: "YOUT-7",
        issueTitle: "修复登录跳转",
        projectId: "proj-1",
        projectTitle: "outbrief",
        issuePriority: "high",
        issueUpdatedAt: "2026-09-28T01:00:00Z",
      },
      {
        workspaceId: "ws-2",
        issueId: "issue-2",
        issueIdentifier: "YOUT-8",
        issueTitle: "没有项目",
        projectId: null,
        projectTitle: null,
        issuePriority: "none",
        issueUpdatedAt: "2026-09-28T02:00:00Z",
      },
      expect.objectContaining({ issueId: "issue-3", projectTitle: "outbrief" }),
    ]);
    // One project lookup serves every issue in it; each issue is read in its own workspace.
    expect(requests.filter((r) => r.path === "/api/projects/proj-1")).toHaveLength(1);
    expect(requests.find((r) => r.path === "/api/issues/issue-2")?.workspace).toBe("ws-2");

    await expect(service.issues([{ workspaceId: "ws-1", issueId: "boom" }])).rejects.toThrow(
      "HTTP 500",
    );
  });
});
