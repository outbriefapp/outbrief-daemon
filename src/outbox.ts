import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEventInput, BriefSubmission } from "./brief/schema.ts";
import { outbriefHome } from "./config.ts";
import type { SealedReport } from "./e2e/payloads.ts";
import type { ReportText } from "./llm/reportText.ts";
import type { MulticaReportInput } from "./multica/ingest.ts";
import { errorText } from "./util.ts";

/** A local agent's report (`POST /v1/daemon/events`) or a finished Multica task (`/multica-reports`). */
export type OutboxReport =
  | { kind: "event"; input: AgentEventInput }
  | { kind: "multica"; input: MulticaReportInput };

/** One accepted report on its way to the server. */
export type OutboxItem = OutboxReport & {
  id: string;
  acceptedAt: string;
  /** Set once generated, so a restart or a failed POST never pays for the brief again. */
  brief: BriefSubmission | null;
  /** Server POSTs that failed transiently so far; drives the backoff. */
  attempts: number;
  lastError: string | null;
};

interface OutboxFile {
  version: 1;
  items: OutboxItem[];
}

export interface OutboxOptions {
  serverUrl: string;
  /** Machine token (`obm_…`). */
  token: string;
  /** Turns a report into its brief; rejects only when `signal` aborted (daemon shutting down). */
  generate: (report: ReportText, signal: AbortSignal) => Promise<BriefSubmission>;
  /**
   * Seals the report with its brief for the server (end-to-end key, ADR 0007). Called at send
   * time, so a report waiting in the outbox is sealed with the key current when it is sent.
   */
  seal: (report: SealedReport) => string;
  log: (message: string) => void;
  path?: string;
  /** Briefs generated at the same time. */
  concurrency?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const POST_TIMEOUT_MS = 30_000;

/** How the server answered one POST. */
type PostOutcome = "created" | "duplicate" | "rejected" | "retry";

/**
 * `~/.outbrief/outbox.json`: every accepted report until the server has it. A report is written here
 * (temp file + rename) before it is acknowledged, then gets its brief (at most `concurrency` at once,
 * started in arrival order) and is POSTed with the brief. Network errors, 5xx and 429 retry with
 * exponential backoff, across restarts too; other 4xx drop the report; 409 means another machine
 * already reported that Multica task.
 */
export class Outbox {
  readonly #options: OutboxOptions;
  readonly #path: string;
  readonly #fetch: typeof fetch;
  readonly #concurrency: number;
  readonly #minBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #items: OutboxItem[];
  /** Waiting for a generation slot, in arrival order. */
  readonly #queue: OutboxItem[] = [];
  readonly #inFlight = new Set<Promise<void>>();
  readonly #retries = new Map<string, NodeJS.Timeout>();
  readonly #shutdown = new AbortController();
  #generating = 0;
  #started = false;

  constructor(options: OutboxOptions) {
    this.#options = options;
    this.#path = options.path ?? join(outbriefHome(), "outbox.json");
    this.#fetch = options.fetch ?? fetch;
    this.#concurrency = options.concurrency ?? 3;
    this.#minBackoffMs = options.minBackoffMs ?? 1_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
    this.#items = load(this.#path, options.log);
  }

  /** Reports not yet accepted by the server, oldest first. */
  get items(): readonly OutboxItem[] {
    return this.#items;
  }

  /** Resumes every report left by the previous run; a pending retry is tried again right away. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (this.#items.length) this.#options.log(`[outbox] resuming ${this.#items.length} report(s)`);
    for (const item of this.#items) this.#schedule(item);
  }

  /**
   * Persists the report, then processes it in the background. Returns once it is on disk (throws when
   * it could not be written), so the caller may acknowledge it. Returns null for a Multica task that
   * is already queued.
   */
  add(report: OutboxReport): OutboxItem | null {
    if (report.kind === "multica") {
      const { taskId } = report.input.multica;
      const queued = this.#items.some(
        (i) => i.kind === "multica" && i.input.multica.taskId === taskId,
      );
      if (queued) return null;
    }
    const item = {
      ...report,
      id: randomUUID(),
      acceptedAt: new Date().toISOString(),
      brief: null,
      attempts: 0,
      lastError: null,
    } as OutboxItem;
    this.#items.push(item);
    try {
      this.#save();
    } catch (err) {
      this.#items.pop();
      throw err;
    }
    if (this.#started) this.#schedule(item);
    return item;
  }

  /** Resolves once nothing is generating or posting (scheduled retries excluded). */
  async idle(): Promise<void> {
    while (this.#inFlight.size) await Promise.allSettled([...this.#inFlight]);
  }

  /** Aborts generation and POSTs; unfinished reports stay on disk for the next start. */
  async close(): Promise<void> {
    this.#queue.length = 0;
    this.#shutdown.abort();
    for (const timer of this.#retries.values()) clearTimeout(timer);
    this.#retries.clear();
    await this.idle();
  }

  #schedule(item: OutboxItem): void {
    if (this.#shutdown.signal.aborted) return;
    if (item.brief) {
      this.#track(this.#post(item));
      return;
    }
    this.#queue.push(item);
    this.#pump();
  }

  #track(task: Promise<void>): void {
    const tracked = task.finally(() => this.#inFlight.delete(tracked));
    this.#inFlight.add(tracked);
  }

  #pump(): void {
    while (this.#generating < this.#concurrency) {
      const item = this.#queue.shift();
      if (!item) return;
      this.#generating++;
      this.#track(
        this.#generate(item).finally(() => {
          this.#generating--;
          this.#pump();
        }),
      );
    }
  }

  async #generate(item: OutboxItem): Promise<void> {
    let brief: BriefSubmission;
    try {
      brief = await this.#options.generate(reportText(item), this.#shutdown.signal);
    } catch (err) {
      if (this.#shutdown.signal.aborted) return;
      // `generate` settles failures as a "failed" brief itself; anything else is a bug worth seeing.
      // The report stays in the outbox and is tried again on the next start.
      this.#options.log(`[outbox] ${label(item)}: brief generation threw — ${errorText(err)}`);
      return;
    }
    // Kept even when shutting down: the next start posts it without paying for it again.
    item.brief = brief;
    this.#saveOrLog();
    if (this.#shutdown.signal.aborted) return;
    await this.#post(item);
  }

  async #post(item: OutboxItem): Promise<void> {
    const outcome = await this.#send(item);
    if (outcome === "retry") {
      if (this.#shutdown.signal.aborted) return;
      item.attempts++;
      this.#saveOrLog();
      const delay = Math.min(this.#minBackoffMs * 2 ** (item.attempts - 1), this.#maxBackoffMs);
      this.#options.log(
        `[outbox] ${label(item)}: server unavailable (${item.lastError}); retry ${item.attempts} in ${Math.round(delay / 1000)} s`,
      );
      const timer = setTimeout(() => {
        this.#retries.delete(item.id);
        this.#schedule(item);
      }, delay);
      this.#retries.set(item.id, timer);
      return;
    }
    const index = this.#items.indexOf(item);
    if (index >= 0) this.#items.splice(index, 1);
    this.#saveOrLog();
    this.#options.log(`[outbox] ${label(item)}: ${outcomeText(item, outcome)}`);
  }

  async #send(item: OutboxItem): Promise<PostOutcome> {
    const path = item.kind === "event" ? "/v1/daemon/events" : "/v1/daemon/multica-reports";
    let res: Response;
    try {
      res = await this.#fetch(`${this.#options.serverUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#options.token}`,
        },
        body: JSON.stringify(this.#body(item)),
        signal: AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(POST_TIMEOUT_MS)]),
      });
    } catch (err) {
      item.lastError = errorText(err).slice(0, 300);
      return "retry";
    }
    if (res.ok) {
      await res.body?.cancel();
      return "created";
    }
    const text = (await res.text().catch(() => "")).slice(0, 300);
    item.lastError = `${res.status} ${text}`.trim();
    if (res.status === 429 || res.status >= 500) return "retry";
    if (res.status === 409 && text.includes("duplicate_task")) return "duplicate";
    return "rejected";
  }

  /** Only what the server routes by stays in the clear; the report and brief are sealed. */
  #body(item: OutboxItem): unknown {
    if (!item.brief) throw new Error(`${label(item)} has no brief yet`);
    const { status, brief, llmChannel, error, generatedAt } = item.brief;
    const envelope = { status, brief, llmChannel, error, generatedAt };
    if (item.kind === "multica") {
      const { title, content, multica } = item.input;
      const { taskId, ...origin } = multica;
      return {
        taskId,
        sealed: this.#options.seal({ title, content, brief: envelope, multica: origin }),
      };
    }
    const { source, occurredAt, title, content, cwd, sessionId } = item.input;
    return {
      source,
      ...(occurredAt ? { occurredAt } : {}),
      sealed: this.#options.seal({ title, content, cwd, sessionId, brief: envelope }),
    };
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    const data: OutboxFile = { version: 1, items: this.#items };
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.#path);
  }

  /** Background progress: an unwritable file must not stop delivery, only be reported. */
  #saveOrLog(): void {
    try {
      this.#save();
    } catch (err) {
      this.#options.log(`[outbox] could not write ${this.#path}: ${errorText(err)}`);
    }
  }
}

function reportText(item: OutboxItem): ReportText {
  if (item.kind === "multica") {
    return { source: "multica", title: item.input.title, content: item.input.content };
  }
  const { source, title, cwd, content } = item.input;
  return { source, title, cwd, content };
}

function label(item: OutboxItem): string {
  if (item.kind === "multica") {
    const { issueIdentifier, agentName } = item.input.multica;
    return `Multica ${issueIdentifier} report from ${agentName}`;
  }
  return `${item.input.source} report (session ${item.input.sessionId ?? "-"})`;
}

function outcomeText(item: OutboxItem, outcome: Exclude<PostOutcome, "retry">): string {
  const brief = item.brief?.status === "ready" ? "with its brief" : "with a failed brief";
  switch (outcome) {
    case "created":
      return `sent as a call ${brief}`;
    case "duplicate":
      return item.kind === "multica"
        ? `task ${item.input.multica.taskId} already has a call`
        : "server already has it";
    case "rejected":
      return `dropped, server refused it (${item.lastError})`;
  }
}

function isItem(value: unknown): value is OutboxItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "event" || v.kind === "multica") &&
    typeof v.id === "string" &&
    !!v.input &&
    typeof v.input === "object" &&
    typeof v.attempts === "number"
  );
}

/**
 * A file that is not valid JSON is moved aside (never silently emptied) so the reports in it can be
 * recovered by hand; the daemon starts with an empty outbox.
 */
function load(path: string, log: (message: string) => void): OutboxItem[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OutboxFile>;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const valid = items.filter(isItem);
    if (valid.length !== items.length) {
      log(`[outbox] ignored ${items.length - valid.length} malformed item(s) in ${path}`);
    }
    return valid.map((item) => ({
      ...item,
      brief: item.brief ?? null,
      lastError: item.lastError ?? null,
    }));
  } catch (err) {
    const aside = `${path}.corrupt-${Date.now()}`;
    renameSync(path, aside);
    log(`[outbox] ${path} is not valid JSON (${errorText(err)}); moved to ${aside}`);
    return [];
  }
}
