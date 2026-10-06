import type { DaemonConfig, MulticaSettings } from "../config.ts";
import { mapLimit } from "../util.ts";
import {
  MulticaApiError,
  MulticaClient,
  type MulticaConfig,
  type MulticaWorkspace,
} from "./client.ts";
import { type MulticaReportInput, readTaskReport } from "./ingest.ts";
import { type CompletedTask, MulticaListener } from "./listener.ts";

/** What the service needs from a running listener. */
export interface RunningListener {
  readonly connected: boolean;
  readonly error: string | null;
  stop(): Promise<void>;
}

/** Whether Multica tasks ring right now; mirrors the app's `MulticaStatus`. */
export interface MulticaStatus {
  /** A Multica token is saved on this machine. */
  configured: boolean;
  /** The realtime connection is authenticated and listening for `task:completed`. */
  connected: boolean;
  /** What the user should fix; null when healthy. */
  error: string | null;
}

/** The saved settings as the app sees them: the token itself never leaves the daemon. */
export interface MulticaSettingsView {
  workspaceId: string;
  workspaceName: string;
  /** e.g. "mul_…9f3a". */
  tokenHint: string;
  updatedAt: string;
}

export interface MulticaSettingsResponse {
  settings: MulticaSettingsView | null;
  status: MulticaStatus;
}

/** An issue as it is now in Multica, for the app's call list; mirrors the app's `MulticaIssueView`. */
export interface MulticaIssueView {
  workspaceId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  projectId: string | null;
  projectTitle: string | null;
  issuePriority: string;
  issueUpdatedAt: string;
}

/** Issues looked up at the same time for one `issues()` call. */
const ISSUE_LOOKUP_CONCURRENCY = 6;

/** The token was rejected by Multica, cannot reach the chosen workspace, or is not set. */
export class MulticaSettingsError extends Error {
  readonly code: "invalid_multica_token" | "workspace_not_found" | "multica_not_configured";

  constructor(code: MulticaSettingsError["code"]) {
    super(code);
    this.name = "MulticaSettingsError";
    this.code = code;
  }
}

export interface MulticaServiceOptions {
  /** The loaded config; `multica` is replaced on save / remove. */
  config: DaemonConfig;
  /** Persists the config (`saveConfig` by default). */
  save: (config: DaemonConfig) => void;
  /**
   * Queues a report for its brief and the server (the outbox, which logs how the server took it);
   * returns false when that task is already queued.
   */
  enqueueReport: (report: MulticaReportInput) => boolean;
  apiUrl: string;
  log: (message: string) => void;
  /** Test seams. */
  fetch?: typeof fetch;
  listen?: (
    config: MulticaConfig,
    onTaskCompleted: (task: CompletedTask) => Promise<void>,
  ) => RunningListener;
  retryDelaysMs?: number[];
}

/** Enough of the token to recognize it. */
export function tokenHint(token: string): string {
  const prefix = token.match(/^[a-z]+_/)?.[0] ?? "";
  return `${prefix}…${token.slice(-4)}`;
}

/** Multica answered 401/403: the token itself is wrong, not the network. */
function isRejectedToken(err: unknown): boolean {
  return err instanceof MulticaApiError && (err.status === 401 || err.status === 403);
}

/**
 * The user's Multica connection, run on their own machine so the token never reaches the cloud:
 * listens to the workspace, reads each finished task and queues it for a call (the outbox generates
 * its brief and hands both to outbrief-server), and posts the user's replies as Multica comments.
 * While the machine is off, Multica tasks do not ring.
 */
export class MulticaService {
  readonly #options: MulticaServiceOptions;
  #client: MulticaClient | null = null;
  #listener: RunningListener | null = null;

  constructor(options: MulticaServiceOptions) {
    this.#options = options;
  }

  /** Connects with the saved token, if any. */
  start(): void {
    const saved = this.#options.config.multica;
    if (saved) this.#connect(saved);
  }

  async stop(): Promise<void> {
    const listener = this.#listener;
    this.#listener = null;
    this.#client = null;
    await listener?.stop();
  }

  status(): MulticaStatus {
    const listener = this.#listener;
    return listener
      ? { configured: true, connected: listener.connected, error: listener.error }
      : { configured: false, connected: false, error: null };
  }

  view(): MulticaSettingsResponse {
    const saved = this.#options.config.multica;
    return {
      settings: saved
        ? {
            workspaceId: saved.workspaceId,
            workspaceName: saved.workspaceName,
            tokenHint: tokenHint(saved.token),
            updatedAt: saved.updatedAt,
          }
        : null,
      status: this.status(),
    };
  }

  /** Workspaces a token can reach; throws `invalid_multica_token` when Multica rejects it. */
  async listWorkspaces(token: string): Promise<MulticaWorkspace[]> {
    try {
      const workspaces = await new MulticaClient(
        { apiUrl: this.#options.apiUrl, token, workspaceId: "" },
        this.#options.fetch,
      ).listWorkspaces();
      return workspaces.map(({ id, name }) => ({ id, name }));
    } catch (err) {
      if (isRejectedToken(err)) throw new MulticaSettingsError("invalid_multica_token");
      throw err;
    }
  }

  /** Checks the token with Multica, saves it on this machine, and reconnects with it. */
  async save(token: string, workspaceId: string): Promise<MulticaSettingsResponse> {
    const workspace = (await this.listWorkspaces(token)).find((w) => w.id === workspaceId);
    if (!workspace) throw new MulticaSettingsError("workspace_not_found");
    const saved: MulticaSettings = {
      token,
      workspaceId,
      workspaceName: workspace.name,
      updatedAt: new Date().toISOString(),
    };
    this.#options.config.multica = saved;
    this.#options.save(this.#options.config);
    await this.stop();
    this.#connect(saved);
    return this.view();
  }

  /** Forgets the token and disconnects: this machine's Multica tasks no longer ring. */
  async remove(): Promise<void> {
    delete this.#options.config.multica;
    this.#options.save(this.#options.config);
    await this.stop();
  }

  /** Posts the user's reply under the agent's report; resolves with the new comment's id. */
  async postReply(
    target: { workspaceId: string; issueId: string; reportCommentId: string },
    content: string,
  ): Promise<string> {
    const saved = this.#options.config.multica;
    if (!saved) throw new Error("这台电脑没有设置 Multica API Token");
    const comment = await this.#clientFor(saved, target.workspaceId).createComment(target.issueId, {
      content,
      parentId: target.reportCommentId,
    });
    return comment.id;
  }

  /**
   * The issues of past calls as they are now (priority, last update, project), so the app sorts its
   * call list by what the user sees in Multica. Issues deleted or out of reach are left out; any
   * other failure rejects.
   */
  async issues(refs: { workspaceId: string; issueId: string }[]): Promise<MulticaIssueView[]> {
    const saved = this.#options.config.multica;
    if (!saved) throw new MulticaSettingsError("multica_not_configured");
    const projects = new Map<string, Promise<string>>();
    const projectTitle = (client: MulticaClient, workspaceId: string, projectId: string) => {
      const key = `${workspaceId}/${projectId}`;
      let title = projects.get(key);
      if (!title) {
        title = client.getProject(projectId).then((p) => p.title);
        projects.set(key, title);
      }
      return title;
    };
    const lookup = async ({ workspaceId, issueId }: (typeof refs)[number]) => {
      const client = this.#clientFor(saved, workspaceId);
      try {
        const issue = await client.getIssue(issueId);
        const projectId = issue.project_id ?? null;
        return {
          workspaceId,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueTitle: issue.title,
          projectId,
          projectTitle: projectId ? await projectTitle(client, workspaceId, projectId) : null,
          issuePriority: issue.priority,
          issueUpdatedAt: issue.updated_at,
        };
      } catch (err) {
        if (err instanceof MulticaApiError && (err.status === 403 || err.status === 404)) {
          return null;
        }
        throw err;
      }
    };
    const found = await mapLimit(refs, ISSUE_LOOKUP_CONCURRENCY, lookup);
    return found.filter((issue) => issue !== null);
  }

  /** A client of `workspaceId` (the saved workspace by default) with the saved token. */
  client(workspaceId?: string): MulticaClient {
    const saved = this.#options.config.multica;
    if (!saved) throw new MulticaSettingsError("multica_not_configured");
    return this.#clientFor(saved, workspaceId ?? saved.workspaceId);
  }

  /** Reports may come from an earlier workspace setting: talk to the report's own workspace. */
  #clientFor(saved: MulticaSettings, workspaceId: string): MulticaClient {
    return this.#client && saved.workspaceId === workspaceId
      ? this.#client
      : new MulticaClient(
          { apiUrl: this.#options.apiUrl, token: saved.token, workspaceId },
          this.#options.fetch,
        );
  }

  #connect(saved: MulticaSettings): void {
    const config: MulticaConfig = {
      apiUrl: this.#options.apiUrl,
      token: saved.token,
      workspaceId: saved.workspaceId,
    };
    const client = new MulticaClient(config, this.#options.fetch);
    const onTask = (task: CompletedTask) => this.#onTaskCompleted(client, task);
    this.#client = client;
    this.#listener = this.#options.listen
      ? this.#options.listen(config, onTask)
      : startListener(config, onTask, this.#options.log);
    this.#options.log(
      `Multica: listening to workspace ${saved.workspaceName} (${saved.workspaceId})`,
    );
  }

  async #onTaskCompleted(client: MulticaClient, task: CompletedTask): Promise<void> {
    const report = await readTaskReport(client, task, this.#options.retryDelaysMs);
    if (!report) {
      this.#options.log(`Multica: task ${task.taskId} posted no comment; no call`);
      return;
    }
    const queued = this.#options.enqueueReport(report);
    this.#options.log(
      queued
        ? `Multica: ${report.multica.issueIdentifier} report from ${report.multica.agentName} queued for its brief`
        : `Multica: task ${task.taskId} is already queued`,
    );
  }
}

function startListener(
  config: MulticaConfig,
  onTaskCompleted: (task: CompletedTask) => Promise<void>,
  log: (message: string) => void,
): RunningListener {
  const listener = new MulticaListener({ config, onTaskCompleted, log });
  listener.start();
  return listener;
}
