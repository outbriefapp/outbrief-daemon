import { setTimeout as sleep } from "node:timers/promises";
import { MulticaApiError, type MulticaClient } from "./client.ts";
import type { CompletedTask } from "./listener.ts";

/** Mirrors outbrief-server `MAX_REPORT_CHARS`. */
export const MAX_REPORT_CHARS = 200_000;

/** `POST /v1/daemon/multica-reports` body; mirrors outbrief-server `MulticaReportInput`. */
export interface MulticaReportInput {
  title: string;
  content: string;
  multica: {
    workspaceId: string;
    /** The workspace's name, so the app can say where a call is from. */
    workspaceName?: string;
    taskId: string;
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    /** The issue's project; null when it is in none. */
    projectId: string | null;
    projectTitle: string | null;
    /** The issue's priority ("urgent" … "none") and last update when the task finished. */
    issuePriority: string;
    issueUpdatedAt: string;
    agentId: string;
    agentName: string;
    /** Last comment the task posted: replying under it wakes that same agent. */
    reportCommentId: string;
  };
}

/** Network errors, 5xx and 429 may pass on their own; other 4xx (deleted issue, no access) will not. */
function isTransient(err: unknown): boolean {
  return (
    err instanceof MulticaApiError &&
    (err.status === null || err.status === 429 || err.status >= 500)
  );
}

async function withRetries<T>(delaysMs: number[], run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !isTransient(err)) throw err;
      await sleep(delay);
    }
  }
}

/**
 * Reads one finished Multica task as a report: the comments the task's agent posted on the issue.
 * Returns null when there is nothing to call about (the task posted no comment).
 */
export async function readTaskReport(
  client: Pick<MulticaClient, "getIssue" | "listComments" | "getAgent" | "getProject" | "config">,
  task: CompletedTask,
  retryDelaysMs: number[] = [1_000, 3_000],
): Promise<MulticaReportInput | null> {
  const [issue, comments, agent] = await withRetries(retryDelaysMs, () =>
    Promise.all([
      client.getIssue(task.issueId),
      client.listComments(task.issueId),
      client.getAgent(task.agentId),
    ]),
  );
  const posted = comments
    .filter((c) => c.source_task_id === task.taskId && c.author_type === "agent")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const report = posted.at(-1);
  const content = posted
    .map((c) => c.content.trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_REPORT_CHARS);
  if (!report || !content) return null;
  const projectId = issue.project_id ?? null;
  const project = projectId
    ? await withRetries(retryDelaysMs, () => client.getProject(projectId))
    : null;
  return {
    title: `${issue.identifier} ${issue.title}`.slice(0, 200),
    content,
    multica: {
      workspaceId: client.config.workspaceId,
      taskId: task.taskId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      projectId,
      projectTitle: project?.title ?? null,
      issuePriority: issue.priority,
      issueUpdatedAt: issue.updated_at,
      agentId: task.agentId,
      agentName: agent.name,
      reportCommentId: report.id,
    },
  };
}
