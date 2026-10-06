import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { outbriefHome } from "../config.ts";
import { mapLimit } from "../util.ts";
import {
  MulticaApiError,
  type MulticaClient,
  type MulticaIssue,
  type MulticaTask,
} from "./client.ts";

/** Longest request the app may send (a few minutes of voice input). */
export const MAX_DISPATCH_PROMPT_CHARS = 8_000;
/**
 * Largest image, decoded: Multica's own upload limit (`maxUploadSize`, 100 MB). Like Multica, a
 * dispatch may carry any number of images: each is uploaded on its own (YOUT-226).
 */
export const MAX_DISPATCH_IMAGE_BYTES = 100 * 1024 * 1024;
/** Dispatches kept on this machine; the oldest go first. */
const MAX_DISPATCHES = 100;
/** Runs of an agent read to find a dispatch's quick-create task (Multica's maximum). */
const TASK_SCAN_LIMIT = 200;
/**
 * Multica links the created issue to the task right after the task completes; a completed task
 * still without an issue this long after is one where the agent created none.
 */
const LINK_GRACE_MS = 60_000;
/** A task no longer among the agent's latest runs after this long is given up on. */
const LOST_AFTER_MS = 24 * 60 * 60 * 1000;
const ISSUE_LOOKUP_CONCURRENCY = 6;

/** A project to dispatch into; mirrors the app's `DispatchProject`. */
export interface DispatchProject {
  id: string;
  title: string;
}

/** An agent to dispatch to; mirrors the app's `DispatchAgent`. */
export interface DispatchAgent {
  id: string;
  name: string;
  description: string;
  /** The machine its runtime is on is online: Multica refuses to dispatch to it otherwise. */
  online: boolean;
}

export interface DispatchOptions {
  projects: DispatchProject[];
  agents: DispatchAgent[];
}

/**
 * - `creating`: the agent is turning the request into an issue (Multica's smart create)
 * - `created`: the issue exists; `issue` is how it was when last read
 * - `failed`: the agent created no issue; `error` says why
 * - `cancelled`: stopped before the issue was created
 */
export type DispatchState = "creating" | "created" | "failed" | "cancelled";

/** One request the user dispatched from the app; mirrors the app's `Dispatch`. */
export interface Dispatch {
  /** The Multica quick-create task. */
  id: string;
  workspaceId: string;
  projectId: string;
  projectTitle: string;
  agentId: string;
  agentName: string;
  /** What the user said, as sent (without the images' markdown). */
  prompt: string;
  /** Images sent with it; absent on dispatches made before images (YOUT-226). */
  images?: number;
  createdAt: string;
  state: DispatchState;
  issue: DispatchIssue | null;
  error: string | null;
}

export interface DispatchIssue {
  id: string;
  identifier: string;
  title: string;
  /** Multica's status key ("todo", "in_progress", "in_review", "done", …). */
  status: string;
  priority: string;
}

/** An image the user attached to a dispatch, as the app uploads it. */
export interface DispatchImage {
  name: string;
  /** `image/png`, `image/jpeg`, … */
  type: string;
  /** Base64 of the file. */
  data: string;
}

/** An image uploaded to the workspace for a dispatch; mirrors the app's `DispatchAttachment`. */
export interface DispatchAttachment {
  id: string;
  filename: string;
  /** The permanent URL of the image, for the request's markdown. */
  markdownUrl: string;
}

/** A dispatch Multica or this machine refused; `code` is the settings API's error. */
export class DispatchError extends Error {
  readonly code:
    | "invalid_dispatch"
    | "agent_unavailable"
    | "project_not_found"
    | "agent_not_found"
    | "dispatch_not_found";

  constructor(code: DispatchError["code"], message: string = code) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
  }
}

/** `~/.outbrief/dispatches.json`, newest first; written atomically after every change. */
export class DispatchStore {
  readonly #path: string;
  #list: Dispatch[];

  constructor(path = join(outbriefHome(), "dispatches.json")) {
    this.#path = path;
    this.#list = loadList(path);
  }

  list(): Dispatch[] {
    return this.#list;
  }

  get(id: string): Dispatch | undefined {
    return this.#list.find((d) => d.id === id);
  }

  /** Replaces the dispatch with the same id, or adds it as the newest. */
  put(dispatch: Dispatch): void {
    const known = this.#list.some((d) => d.id === dispatch.id);
    this.#list = known
      ? this.#list.map((d) => (d.id === dispatch.id ? dispatch : d))
      : [dispatch, ...this.#list].slice(0, MAX_DISPATCHES);
    this.#save();
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ dispatches: this.#list }), { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}

function loadList(path: string): Dispatch[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { dispatches?: unknown };
    return Array.isArray(parsed.dispatches) ? (parsed.dispatches as Dispatch[]) : [];
  } catch {
    return [];
  }
}

export interface DispatcherOptions {
  /**
   * A client of `workspaceId`, or of the first saved workspace; throws `multica_not_configured` when no
   * token is saved.
   */
  client: (workspaceId?: string) => MulticaClient;
  store: DispatchStore;
  now?: () => Date;
}

/**
 * 主动派单: the user says what they want on their phone; this machine (which holds the Multica
 * token) asks Multica's smart create to have the picked agent turn it into an issue in the picked
 * project, and keeps the list of what was dispatched so every device of the account sees it.
 */
export class Dispatcher {
  readonly #client: DispatcherOptions["client"];
  readonly #store: DispatchStore;
  readonly #now: () => Date;

  constructor(options: DispatcherOptions) {
    this.#client = options.client;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * The workspace's open projects and its agents, with whether each agent can run now (the first
   * saved workspace when none is given).
   */
  async options(workspaceId?: string): Promise<DispatchOptions> {
    const client = this.#client(workspaceId);
    const [projects, agents, runtimes] = await Promise.all([
      client.listProjects(),
      client.listAgents(),
      client.listRuntimes(),
    ]);
    const online = new Set(runtimes.filter((r) => r.status === "online").map((r) => r.id));
    return {
      projects: projects
        .filter((p) => p.status !== "completed" && p.status !== "cancelled")
        .map(({ id, title }) => ({ id, title })),
      agents: agents
        .filter((a) => !a.archived_at)
        .map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description ?? "",
          online: !!a.runtime_id && online.has(a.runtime_id),
        })),
    };
  }

  /**
   * Uploads one image to the workspace, not bound to an issue yet; the app uploads a dispatch's
   * images one by one, then sends their attachments with `create`.
   */
  async upload(image: DispatchImage, workspaceId?: string): Promise<DispatchAttachment> {
    const data = Buffer.from(image.data, "base64");
    if (
      !/^image\/[\w.+-]+$/.test(image.type) ||
      !data.length ||
      data.length > MAX_DISPATCH_IMAGE_BYTES
    ) {
      throw new DispatchError("invalid_dispatch");
    }
    const uploaded = await this.#client(workspaceId).uploadFile({
      name: image.name.trim() || "image",
      type: image.type,
      data,
    });
    return { id: uploaded.id, filename: uploaded.filename, markdownUrl: uploaded.markdown_url };
  }

  /**
   * Hands the request to Multica's smart create and records it as `creating`. Uploaded images go
   * in the request as markdown with their ids in `attachment_ids`, the way Multica's own
   * quick-create dialog does: the agent keeps them in the issue's description and binds them to
   * the issue.
   */
  async create(input: {
    /** The first saved workspace when absent. */
    workspaceId?: string;
    projectId: string;
    agentId: string;
    prompt: string;
    attachments?: DispatchAttachment[];
  }): Promise<Dispatch> {
    const prompt = input.prompt.trim();
    const attachments = input.attachments ?? [];
    if ((!prompt && !attachments.length) || prompt.length > MAX_DISPATCH_PROMPT_CHARS) {
      throw new DispatchError("invalid_dispatch");
    }
    if (!attachments.every((a) => /^https?:\/\/[^\s()]+$/.test(a.markdownUrl) && !!a.id)) {
      throw new DispatchError("invalid_dispatch");
    }
    const client = this.#client(input.workspaceId);
    const [project, agent] = await Promise.all([
      client.getProject(input.projectId).catch(notFound<never>("project_not_found")),
      client.getAgent(input.agentId).catch(notFound<never>("agent_not_found")),
    ]);
    let taskId: string;
    try {
      ({ taskId } = await client.quickCreateIssue({
        agentId: agent.id,
        projectId: project.id,
        prompt: [prompt, ...attachments.map(imageMarkdown)].filter(Boolean).join("\n\n"),
        attachmentIds: attachments.map((a) => a.id),
      }));
    } catch (err) {
      throw refusal(err);
    }
    const dispatch: Dispatch = {
      id: taskId,
      workspaceId: client.config.workspaceId,
      projectId: project.id,
      projectTitle: project.title,
      agentId: agent.id,
      agentName: agent.name,
      prompt,
      images: attachments.length,
      createdAt: this.#now().toISOString(),
      state: "creating",
      issue: null,
      error: null,
    };
    this.#store.put(dispatch);
    return dispatch;
  }

  /** Every dispatch, as it is now in Multica. */
  async list(): Promise<Dispatch[]> {
    await this.#refresh(this.#store.list());
    return this.#store.list();
  }

  /** One dispatch, as it is now in Multica. */
  async lookup(id: string): Promise<Dispatch> {
    const dispatch = this.#store.get(id);
    if (!dispatch) throw new DispatchError("dispatch_not_found");
    await this.#refresh([dispatch]);
    return this.#store.get(id) ?? dispatch;
  }

  /** Stops the agent before it creates the issue; a dispatch that already has one is left as is. */
  async cancel(id: string): Promise<Dispatch> {
    const dispatch = await this.lookup(id);
    if (dispatch.state !== "creating") return dispatch;
    await this.#client(dispatch.workspaceId).cancelTask(dispatch.id);
    const cancelled: Dispatch = { ...dispatch, state: "cancelled" };
    this.#store.put(cancelled);
    return cancelled;
  }

  async #refresh(dispatches: Dispatch[]): Promise<void> {
    const creating = dispatches.filter((d) => d.state === "creating");
    // One read of an agent's latest runs answers all of its dispatches still being created.
    const byAgent = new Map<string, Dispatch[]>();
    for (const d of creating) {
      const key = `${d.workspaceId}/${d.agentId}`;
      byAgent.set(key, [...(byAgent.get(key) ?? []), d]);
    }
    await mapLimit([...byAgent.values()], ISSUE_LOOKUP_CONCURRENCY, async (group) => {
      const first = group[0] as Dispatch;
      const client = this.#client(first.workspaceId);
      const tasks = await client.listAgentTasks(first.agentId, TASK_SCAN_LIMIT);
      for (const d of group) {
        await this.#settle(
          client,
          d,
          tasks.find((t) => t.id === d.id),
        );
      }
    });
    const created = dispatches.filter((d) => d.state === "created" && d.issue);
    await mapLimit(created, ISSUE_LOOKUP_CONCURRENCY, async (d) => {
      const issue = await this.#client(d.workspaceId)
        .getIssue((d.issue as DispatchIssue).id)
        .catch(notFound<null>(null));
      // A deleted issue keeps how it was last seen.
      if (issue) this.#store.put({ ...d, issue: issueView(issue) });
    });
  }

  /** Moves a `creating` dispatch on by what its task says. */
  async #settle(client: MulticaClient, d: Dispatch, task: MulticaTask | undefined): Promise<void> {
    const now = this.#now().getTime();
    if (!task) {
      if (now - Date.parse(d.createdAt) > LOST_AFTER_MS) {
        this.#store.put({ ...d, state: "failed", error: "task_lost" });
      }
      return;
    }
    if (task.issue_id) {
      const issue = await client.getIssue(task.issue_id);
      this.#store.put({ ...d, state: "created", issue: issueView(issue), error: null });
      return;
    }
    if (task.status === "failed") {
      this.#store.put({ ...d, state: "failed", error: task.error || "task_failed" });
      return;
    }
    if (task.status === "cancelled") {
      this.#store.put({ ...d, state: "cancelled" });
      return;
    }
    if (task.status === "completed") {
      const completedAt = task.completed_at ? Date.parse(task.completed_at) : now;
      if (now - completedAt > LINK_GRACE_MS) {
        this.#store.put({ ...d, state: "failed", error: task.error || "no_issue_created" });
      }
    }
  }
}

/** `![name](url)`, with the characters that would end the alt text or the link taken out. */
function imageMarkdown(image: DispatchAttachment): string {
  return `![${image.filename.replace(/[[\]()\n]/g, " ").trim()}](${image.markdownUrl})`;
}

function issueView(issue: MulticaIssue): DispatchIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status ?? "",
    priority: issue.priority,
  };
}

/** A 404 / 403 from Multica becomes `fallback` (an error to throw, or a value); others rethrow. */
function notFound<T>(fallback: DispatchError["code"] | null): (err: unknown) => T {
  return (err) => {
    if (err instanceof MulticaApiError && (err.status === 404 || err.status === 403)) {
      if (fallback === null) return null as T;
      throw new DispatchError(fallback);
    }
    throw err;
  };
}

/** Multica's reason for refusing a quick-create, as a `DispatchError` when it is one the app can explain. */
function refusal(err: unknown): unknown {
  if (!(err instanceof MulticaApiError) || err.status !== 422) return err;
  let body: { code?: unknown; reason?: unknown } = {};
  try {
    body = JSON.parse(err.body) as typeof body;
  } catch {
    return err;
  }
  if (body.code !== "agent_unavailable") return err;
  return new DispatchError(
    "agent_unavailable",
    typeof body.reason === "string" ? body.reason : "agent_unavailable",
  );
}
