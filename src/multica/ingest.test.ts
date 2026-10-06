import { describe, expect, it } from "vitest";
import { MulticaApiError, type MulticaComment } from "./client.ts";
import { readTaskReport } from "./ingest.ts";

const TASK = { taskId: "task-1", issueId: "issue-1", agentId: "agent-1" };

function comment(id: string, overrides: Partial<MulticaComment> = {}): MulticaComment {
  return {
    id,
    author_type: "agent",
    content: `comment ${id}`,
    created_at: "2026-09-26T10:00:00Z",
    source_task_id: TASK.taskId,
    ...overrides,
  };
}

function client(
  comments: MulticaComment[],
  failures: MulticaApiError[] = [],
  projectId: string | null = "proj-1",
) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    config: { apiUrl: "https://multica.test", token: "mul_x", workspaceId: "ws-1" },
    async getIssue(id: string) {
      calls++;
      const failure = failures.shift();
      if (failure) throw failure;
      return {
        id,
        identifier: "YOUT-7",
        title: "修复登录跳转",
        priority: "high",
        project_id: projectId,
        updated_at: "2026-09-26T10:06:00Z",
      };
    },
    async getProject(id: string) {
      return { id, title: "outbrief" };
    },
    async listComments() {
      return comments;
    },
    async getAgent(id: string) {
      return { id, name: "Mika" };
    },
  };
}

describe("readTaskReport", () => {
  it("turns the comments the task posted into a report that replies under the last one", async () => {
    const report = await readTaskReport(
      client([
        comment("c0", { author_type: "member", source_task_id: null, content: "请修一下" }),
        comment("c2", { created_at: "2026-09-26T10:05:00Z", content: "第二段：测试都过了" }),
        comment("c1", { created_at: "2026-09-26T10:04:00Z", content: "第一段：改好了" }),
        comment("other", { source_task_id: "task-0", content: "上一个任务的汇报" }),
      ]),
      TASK,
    );
    expect(report).toEqual({
      title: "YOUT-7 修复登录跳转",
      content: "第一段：改好了\n\n第二段：测试都过了",
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
        reportCommentId: "c2",
      },
    });
  });

  it("leaves the project empty for an issue in no project", async () => {
    const report = await readTaskReport(client([comment("c1")], [], null), TASK);
    expect(report?.multica).toMatchObject({ projectId: null, projectTitle: null });
  });

  it("returns null when the task posted no comment", async () => {
    expect(await readTaskReport(client([comment("x", { source_task_id: "t0" })]), TASK)).toBeNull();
  });

  it("retries transient Multica failures but not a missing issue", async () => {
    const flaky = client([comment("c1")], [new MulticaApiError("HTTP 503", 503)]);
    expect(await readTaskReport(flaky, TASK, [1, 1])).not.toBeNull();
    expect(flaky.calls).toBe(2);

    const gone = client([comment("c1")], [new MulticaApiError("HTTP 404: not found", 404)]);
    await expect(readTaskReport(gone, TASK, [1, 1])).rejects.toThrow("HTTP 404");
    expect(gone.calls).toBe(1);
  });
});
