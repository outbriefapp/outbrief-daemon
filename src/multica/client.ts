import { errorText } from "../util.ts";

/** The user's Multica connection, kept only in this machine's `daemon.json`. */
export interface MulticaConfig {
  /** Multica API origin, e.g. https://api.multica.ai; the realtime socket is `/ws` on it. */
  apiUrl: string;
  /** Personal access token (mul_…); OutBrief reads tasks and posts replies as this user. */
  token: string;
  /** Empty only for calls outside a workspace (`listWorkspaces`). */
  workspaceId: string;
}

/** Multica answered with a non-2xx status or an unexpected body, or could not be reached. */
export class MulticaApiError extends Error {
  /** HTTP status; null when no response arrived. */
  readonly status: number | null;
  /** The error response's text, when one arrived. */
  readonly body: string;

  constructor(message: string, status: number | null, body = "") {
    super(message);
    this.name = "MulticaApiError";
    this.status = status;
    this.body = body;
  }
}

export interface MulticaIssue {
  id: string;
  identifier: string;
  title: string;
  /** "urgent" | "high" | "medium" | "low" | "none" today; kept as Multica sends it. */
  priority: string;
  /** Null / absent when the issue is in no project. */
  project_id?: string | null;
  /** "todo" | "in_progress" | "in_review" | "done" | … (custom statuses too); absent on old servers. */
  status?: string;
  /** "member" | "agent" | "squad"; null when nobody is assigned. */
  assignee_type?: string | null;
  assignee_id?: string | null;
  updated_at: string;
}

export interface MulticaProject {
  id: string;
  title: string;
}

export interface MulticaComment {
  id: string;
  author_type: string;
  content: string;
  created_at: string;
  /** Set on comments an agent posted while running that task. */
  source_task_id?: string | null;
}

export interface MulticaAgent {
  id: string;
  name: string;
}

export interface MulticaWorkspace {
  id: string;
  name: string;
}

/** An agent as `GET /api/agents` lists it (only what dispatching needs). */
export interface MulticaAgentEntry {
  id: string;
  name: string;
  description?: string | null;
  /** The runtime (a machine's CLI) it runs on; null when none is bound. */
  runtime_id?: string | null;
  archived_at?: string | null;
}

export interface MulticaRuntime {
  id: string;
  name: string;
  /** "online" | "offline". */
  status: string;
}

/** A project as `GET /api/projects` lists it. */
export interface MulticaProjectEntry {
  id: string;
  title: string;
  /** "planned" | "in_progress" | "paused" | "completed" | "cancelled". */
  status?: string;
}

/** A file uploaded to the workspace (`POST /api/upload-file`), not bound to an issue yet. */
export interface MulticaAttachment {
  id: string;
  filename: string;
  /** The permanent URL to put in markdown (`download_url` is short-lived). */
  markdown_url: string;
}

/** One run of an agent (`GET /api/agents/<id>/tasks`). */
export interface MulticaTask {
  id: string;
  /** "queued" | "dispatched" | "running" | "completed" | "failed" | "cancelled". */
  status: string;
  /** Empty until a quick-create task is linked to the issue it created. */
  issue_id?: string | null;
  error?: string | null;
  completed_at?: string | null;
}

const REQUEST_TIMEOUT_MS = 15_000;
/** An upload carries a few MB of image. */
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Reads (GET) that fail in transit or with a 429 / 5xx are retried up to 3 times, after these
 * waits: the connection to Multica drops now and then ("fetch failed", YOUT-212). Writes are not
 * retried, so a comment is never posted twice.
 */
const RETRY_DELAYS_MS = [500, 1_000, 2_000];

/** "fetch failed (ECONNRESET)": undici hides why in `cause`. */
function transportText(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string }) : null;
  const why = cause?.code ?? cause?.message;
  return why ? `${errorText(err)} (${why})` : errorText(err);
}

function retryable(err: unknown): boolean {
  if (!(err instanceof MulticaApiError)) return false;
  return err.status === null || err.status === 429 || err.status >= 500;
}

type Check<T> = (value: unknown) => value is T;

function hasStrings<K extends string>(value: unknown, keys: K[]): value is Record<K, string> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return keys.every((k) => typeof record[k] === "string");
}

const isIssue: Check<MulticaIssue> = (v): v is MulticaIssue => {
  if (!hasStrings(v, ["id", "identifier", "title", "priority", "updated_at"])) return false;
  const projectId = (v as Record<string, unknown>).project_id;
  return projectId == null || typeof projectId === "string";
};
const isProject: Check<MulticaProject> = (v): v is MulticaProject => hasStrings(v, ["id", "title"]);
const isComment: Check<MulticaComment> = (v): v is MulticaComment =>
  hasStrings(v, ["id", "author_type", "content", "created_at"]);
const isNamed: Check<MulticaAgent> = (v): v is MulticaAgent => hasStrings(v, ["id", "name"]);
const isRuntime: Check<MulticaRuntime> = (v): v is MulticaRuntime =>
  hasStrings(v, ["id", "name", "status"]);
const isTask: Check<MulticaTask> = (v): v is MulticaTask => hasStrings(v, ["id", "status"]);
const isProjectList: Check<{ projects: MulticaProjectEntry[] }> = (
  v,
): v is { projects: MulticaProjectEntry[] } =>
  !!v && typeof v === "object" && arrayOf(isProject)((v as { projects?: unknown }).projects);
const isIssueList: Check<{ issues: MulticaIssue[] }> = (v): v is { issues: MulticaIssue[] } =>
  !!v && typeof v === "object" && arrayOf(isIssue)((v as { issues?: unknown }).issues);
const isQuickCreate: Check<{ task_id: string }> = (v): v is { task_id: string } =>
  hasStrings(v, ["task_id"]);
// Multica answers `{ id: "" }` when it stored the file but not its attachment row.
const isAttachment: Check<MulticaAttachment> = (v): v is MulticaAttachment =>
  hasStrings(v, ["id", "filename", "markdown_url"]) && !!v.id && !!v.markdown_url;

function arrayOf<T>(check: Check<T>): Check<T[]> {
  return (v): v is T[] => Array.isArray(v) && v.every(check);
}

const isAnything: Check<unknown> = (_v): _v is unknown => true;

/** A JSON `body`, or a multipart `form`. */
interface CallInit {
  method: "GET" | "POST";
  body?: unknown;
  form?: FormData;
  timeoutMs?: number;
}

/** The few Multica REST calls OutBrief needs, authenticated with the user's PAT. */
export class MulticaClient {
  readonly config: MulticaConfig;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    config: MulticaConfig,
    fetchImpl: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.config = config;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
  }

  getIssue(issueId: string): Promise<MulticaIssue> {
    return this.#request(isIssue, `/api/issues/${encodeURIComponent(issueId)}`);
  }

  /** The issue's comments, oldest first (Multica keeps the newest 2 000). */
  listComments(issueId: string): Promise<MulticaComment[]> {
    return this.#request(arrayOf(isComment), `/api/issues/${encodeURIComponent(issueId)}/comments`);
  }

  /**
   * The project's issues, most recently active first (Multica answers at most 100); `query` keeps
   * those whose title has every word of it, or whose number it is.
   */
  async listIssues(input: {
    projectId: string;
    query?: string;
    limit: number;
  }): Promise<MulticaIssue[]> {
    const params = new URLSearchParams({
      project_id: input.projectId,
      sort: "last_activity",
      limit: String(input.limit),
    });
    if (input.query) params.set("q", input.query);
    return (await this.#request(isIssueList, `/api/issues?${params}`)).issues;
  }

  getProject(projectId: string): Promise<MulticaProject> {
    return this.#request(isProject, `/api/projects/${encodeURIComponent(projectId)}`);
  }

  getAgent(agentId: string): Promise<MulticaAgent> {
    return this.#request(isNamed, `/api/agents/${encodeURIComponent(agentId)}`);
  }

  /** Workspaces the PAT's user belongs to; needs no workspace, so it also checks a new token. */
  listWorkspaces(): Promise<MulticaWorkspace[]> {
    return this.#request(arrayOf(isNamed), "/api/workspaces");
  }

  /** The workspace's agents the PAT's user can see (archived ones left out by Multica). */
  listAgents(): Promise<MulticaAgentEntry[]> {
    return this.#request(arrayOf(isNamed), "/api/agents");
  }

  /** The workspace's runtimes, with whether each one's machine is online. */
  listRuntimes(): Promise<MulticaRuntime[]> {
    return this.#request(arrayOf(isRuntime), "/api/runtimes");
  }

  async listProjects(): Promise<MulticaProjectEntry[]> {
    return (await this.#request(isProjectList, "/api/projects")).projects;
  }

  /** The agent's runs, newest first (Multica answers at most 200). */
  listAgentTasks(agentId: string, limit: number): Promise<MulticaTask[]> {
    return this.#request(
      arrayOf(isTask),
      `/api/agents/${encodeURIComponent(agentId)}/tasks?limit=${limit}`,
    );
  }

  /**
   * Multica's smart create (the web app's quick-create): the agent turns `prompt` into an issue —
   * title, description, priority and due date from what was said — assigned to itself, in
   * `projectId`. Answers at once with the queued task; the issue appears when the agent is done.
   */
  async quickCreateIssue(input: {
    agentId: string;
    projectId: string;
    prompt: string;
    /** Uploads referenced in `prompt`: the agent's `multica issue create` binds them to the issue. */
    attachmentIds?: string[];
  }): Promise<{ taskId: string }> {
    const body = await this.#request(isQuickCreate, "/api/issues/quick-create", {
      method: "POST",
      body: {
        agent_id: input.agentId,
        project_id: input.projectId,
        prompt: input.prompt,
        ...(input.attachmentIds?.length ? { attachment_ids: input.attachmentIds } : {}),
      },
    });
    return { taskId: body.task_id };
  }

  /**
   * Uploads a file to the workspace without an issue (as `multica issue create --attachment`
   * does); it is bound to the issue that later lists its id in `attachment_ids`.
   */
  uploadFile(file: { name: string; type: string; data: Uint8Array }): Promise<MulticaAttachment> {
    const form = new FormData();
    form.append("file", new Blob([file.data], { type: file.type }), file.name);
    return this.#request(isAttachment, "/api/upload-file", {
      method: "POST",
      form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  }

  /** Stops a queued or running task, as its requester. */
  async cancelTask(taskId: string): Promise<void> {
    await this.#request(isAnything, `/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
  }

  /**
   * Posts a comment as the PAT's user. Replying to an agent's comment (`parentId`) makes Multica
   * start that agent on the reply; a new top-level comment starts the issue's assigned agent.
   */
  createComment(
    issueId: string,
    input: {
      content: string;
      /** Absent for a new top-level comment. */
      parentId?: string;
      /** Uploads referenced in `content`: Multica binds them to the comment. */
      attachmentIds?: string[];
    },
  ): Promise<MulticaComment> {
    return this.#request(isComment, `/api/issues/${encodeURIComponent(issueId)}/comments`, {
      method: "POST",
      body: {
        content: input.content,
        ...(input.parentId ? { parent_id: input.parentId } : {}),
        ...(input.attachmentIds?.length ? { attachment_ids: input.attachmentIds } : {}),
      },
    });
  }

  async #request<T>(check: Check<T>, path: string, init: CallInit = { method: "GET" }): Promise<T> {
    for (let retry = 0; ; retry++) {
      try {
        return await this.#attempt(check, path, init);
      } catch (err) {
        const wait = RETRY_DELAYS_MS[retry];
        if (init.method !== "GET" || wait === undefined || !retryable(err)) throw err;
        await this.#sleep(wait);
      }
    }
  }

  async #attempt<T>(check: Check<T>, path: string, init: CallInit): Promise<T> {
    const label = `${init.method} ${path}`;
    let resp: Response;
    try {
      resp = await this.#fetch(new URL(path, this.config.apiUrl), {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          ...(this.config.workspaceId ? { "X-Workspace-ID": this.config.workspaceId } : {}),
          Accept: "application/json",
          // A FormData body sets its own multipart Content-Type.
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
        signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MulticaApiError(`${label}: ${transportText(err)}`, null);
    }
    const text = await resp.text();
    if (!resp.ok) {
      throw new MulticaApiError(
        `${label} → HTTP ${resp.status}: ${text.slice(0, 300)}`,
        resp.status,
        text,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MulticaApiError(`${label}: response is not JSON`, resp.status);
    }
    if (!check(json)) throw new MulticaApiError(`${label}: unexpected response`, resp.status);
    return json;
  }
}
