import { timingSafeEqual } from "node:crypto";
import type * as http from "node:http";
import { type BriefSettings, BriefSettingsError } from "./brief/settings.ts";
import { E2eKeyError, type E2eKeyring } from "./e2e/keyring.ts";
import type { StructuredOutput } from "./llm/client.ts";
import { type LlmSettings, LlmSettingsError } from "./llm/settings.ts";
import { type DispatchAttachment, DispatchError, type Dispatcher } from "./multica/dispatch.ts";
import { type MulticaService, MulticaSettingsError } from "./multica/service.ts";
import type { LocalPairing } from "./pairing.ts";
import { errorText } from "./util.ts";

/** Room for one dispatch image: Multica's 100 MB upload limit, base64. */
const MAX_BODY_BYTES = 140 * 1024 * 1024;
/** Issues one `POST /multica/issues` may ask about (the app keeps at most 100 calls). */
const MAX_ISSUE_REFS = 100;
const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
type Method = (typeof METHODS)[number];

export interface SettingsApiOptions {
  multica: Pick<MulticaService, "view" | "listWorkspaces" | "save" | "remove" | "issues">;
  dispatcher: Pick<
    Dispatcher,
    "options" | "issues" | "upload" | "create" | "list" | "lookup" | "cancel"
  >;
  e2e: Pick<E2eKeyring, "view" | "set" | "openSettingsRequest" | "sealSettingsResult">;
  llm: Pick<LlmSettings, "view" | "save" | "remove">;
  brief: Pick<BriefSettings, "view" | "save">;
  /** A pairing code (and this machine's key) for the app on this machine: `POST /local/pairing`. */
  pairing: () => Promise<LocalPairing>;
  /** Contents of `local-api.key`: the bearer only this machine's user can read. */
  localKey: string;
  port: number;
  log: (message: string) => void;
}

/** What a route answers; `body: undefined` is a 204. */
export interface SettingsResult {
  status: number;
  body?: unknown;
}

/**
 * The settings API. Locally on 127.0.0.1, so the Multica token, the end-to-end key and the LLM
 * key go between the app and this machine and never through the cloud; or relayed by the server,
 * sealed with the end-to-end key, for an app with no daemon of its own (a phone):
 *
 * - `GET /multica/settings` → `{ settings, status }` (only a token hint, never the token)
 * - `POST /multica/workspaces` `{ token? }` → `{ workspaces }` (the saved token's without one); 422
 *   `invalid_multica_token` / `multica_not_configured`
 * - `PUT /multica/settings` `{ token?, workspaceIds }` (every workspace to listen to; no token keeps
 *   the saved one; an older app's
 *   `{ token, workspaceId }` is a list of one); 422 `invalid_multica_token` / `workspace_not_found`
 * - `DELETE /multica/settings` → 204
 * - `POST /multica/issues` `{ issues: [{ workspaceId, issueId }] }` → `{ issues }`: those issues as
 *   they are now (project, priority, last update) for the app's call list; missing ones are left
 *   out; 422 `multica_not_configured`
 * - `GET /multica/dispatch/options` → `{ projects, agents }`: where the app can dispatch to in the
 *   first workspace; `POST /multica/dispatch/options` `{ workspaceId }` the same in that one; and
 *   whether each agent's machine is online
 * - `POST /multica/dispatch/issues` `{ projectId, query?, workspaceId? }` → `{ issues }`: the
 *   project's issues, most recently active first, that a dispatch may comment on instead
 * - `POST /multica/uploads` `{ name, type, data, workspaceId? }` (one image, base64, at most Multica's 100 MB)
 *   → `{ attachment: { id, filename, markdownUrl } }`: uploaded to the workspace for a dispatch;
 *   400 `invalid_dispatch` when it is not an image or is too big
 * - `POST /multica/dispatches` `{ projectId, agentId, prompt, attachments?, workspaceId? }` → `{ dispatch }`: the
 *   picked agent turns what the user said (and the uploaded images) into an issue (Multica's smart
 *   create); 422 `agent_unavailable` (with Multica's `message`) / `project_not_found` /
 *   `agent_not_found`, 400 `invalid_dispatch`; with `issueId` (no `projectId` / `agentId` needed)
 *   it is posted as a comment on that issue instead (OUTB-61), 422 `issue_not_found`
 * - `GET /multica/dispatches` → `{ dispatches }`: what was dispatched from this machine, newest
 *   first, as it is now in Multica
 * - `POST /multica/dispatches/lookup` `{ id }` → `{ dispatch }`: one of them; 422 `dispatch_not_found`
 * - `POST /multica/dispatches/cancel` `{ id }` → `{ dispatch }`: stops the agent before it creates
 *   the issue
 * - `GET /llm/settings` → `{ channel }`: the brief endpoint (key hint only), null when none
 * - `PUT /llm/settings` `{ baseUrl, apiKey?, model, structuredOutput? }` → `{ channel }`; no
 *   `apiKey` keeps the saved key; 422 `invalid_llm_settings` / `llm_key_required`
 * - `DELETE /llm/settings` → `{ channel: null }`
 * - `GET /brief/language` → `{ language, source }`: the language briefs are written in
 * - `PUT /brief/language` `{ language }` → the same; 422 `invalid_language`
 *
 * Local only (403 `not_relayed` through the server):
 *
 * - `GET /e2e/key` → `{ key, keyId, source, updatedAt }`: the app on this machine uses the same key
 * - `PUT /e2e/key` `{ passphrase }` | `{ key }` | `{ random: true }` → the new key; 422
 *   `passphrase_too_short` / `invalid_key`
 * - `POST /local/pairing` → `{ serverUrl, code, key, expiresAt, link }`: the desktop app on this
 *   machine joins this machine's account with it (and follows its key)
 *
 * Locally every call needs `Authorization: Bearer <local-api.key>` — a file only this machine's
 * user can read — so a web page in a browser cannot read or change anything; the Host header must
 * name this loopback port (DNS rebinding).
 */
export function createSettingsApi(options: SettingsApiOptions) {
  const localKey = Buffer.from(options.localKey);

  function authorized(req: http.IncomingMessage): boolean {
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearer) return false;
    const given = Buffer.from(bearer);
    return given.length === localKey.length && timingSafeEqual(given, localKey);
  }

  function loopbackHost(req: http.IncomingMessage): boolean {
    const host = req.headers.host ?? "";
    return host === `127.0.0.1:${options.port}` || host === `localhost:${options.port}`;
  }

  async function dispatch(
    method: Method,
    path: string,
    body: unknown,
    relayed: boolean,
  ): Promise<SettingsResult> {
    if (relayed && (path.startsWith("/e2e/") || path.startsWith("/local/"))) {
      return { status: 403, body: { error: "not_relayed" } };
    }
    try {
      return await route(options, method, path, body);
    } catch (err) {
      if (err instanceof MulticaSettingsError) return { status: 422, body: { error: err.code } };
      if (err instanceof DispatchError) {
        return {
          status: err.code === "invalid_dispatch" ? 400 : 422,
          body: { error: err.code, message: err.message },
        };
      }
      if (err instanceof E2eKeyError) return { status: 422, body: { error: err.code } };
      if (err instanceof LlmSettingsError) return { status: 422, body: { error: err.code } };
      if (err instanceof BriefSettingsError) return { status: 422, body: { error: err.code } };
      options.log(`[settings] ${method} ${path} failed: ${errorText(err)}`);
      // Every other route talks to Multica; the pairing one to the OutBrief server.
      const error = path === "/local/pairing" ? "server_failed" : "multica_failed";
      return { status: 502, body: { error, message: errorText(err) } };
    }
  }

  /** Handles the request when it is a settings route; returns false otherwise. */
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (!SETTINGS_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
    cors(req, res);
    if (!loopbackHost(req)) return send(res, { status: 403, body: { error: "forbidden_host" } });
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (!authorized(req)) return send(res, { status: 401, body: { error: "unauthorized" } });
    const method = METHODS.find((m) => m === req.method);
    if (!method) return send(res, { status: 404, body: { error: "not_found" } });
    const body = method === "GET" || method === "DELETE" ? undefined : await readJson(req);
    return send(res, await dispatch(method, path, body, false));
  }

  /**
   * Answers a sealed settings request the server relayed from an app of this account. The request
   * is `{ method, path, body? }`; the sealed answer is `{ status, body }`. A request this machine
   * cannot open is answered in the clear with no content, so the app can tell the keys differ.
   */
  async function relay(requestId: string, sealed: string): Promise<string> {
    let request: unknown;
    try {
      request = options.e2e.openSettingsRequest(requestId, sealed);
    } catch (err) {
      options.log(`[settings] relayed request ${requestId} could not be opened: ${errorText(err)}`);
      return options.e2e.sealSettingsResult(requestId, {
        status: 400,
        body: { error: "undecryptable_request" },
      });
    }
    const method = METHODS.find((m) => m === stringField(request, "method"));
    const path = stringField(request, "path");
    const result =
      method && path
        ? await dispatch(method, path, (request as { body?: unknown }).body, true)
        : { status: 400, body: { error: "invalid_settings_request" } };
    options.log(`[settings] relayed ${method ?? "?"} ${path ?? "?"} → ${result.status}`);
    return options.e2e.sealSettingsResult(requestId, result);
  }

  return { handle, relay };
}

export type SettingsApi = ReturnType<typeof createSettingsApi>;

const SETTINGS_PREFIXES = ["/multica/", "/e2e/", "/llm/", "/brief/", "/local/"];

async function route(
  options: SettingsApiOptions,
  method: Method,
  path: string,
  body: unknown,
): Promise<SettingsResult> {
  if (path === "/e2e/key" && method === "GET") return { status: 200, body: options.e2e.view() };
  if (path === "/e2e/key" && method === "PUT") {
    const passphrase = rawString(body, "passphrase");
    const key = stringField(body, "key");
    const random =
      !!body && typeof body === "object" && (body as { random?: unknown }).random === true;
    const view = options.e2e.set(
      passphrase !== undefined ? { passphrase } : key ? { key } : { random },
    );
    options.log(`[e2e] key replaced by the app: ${view.keyId} (${view.source})`);
    return { status: 200, body: view };
  }
  if (path === "/local/pairing" && method === "POST") {
    return { status: 200, body: await options.pairing() };
  }
  if (path === "/brief/language" && method === "GET") {
    return { status: 200, body: options.brief.view() };
  }
  if (path === "/brief/language" && method === "PUT") {
    return { status: 200, body: options.brief.save(stringField(body, "language")) };
  }
  if (path === "/llm/settings" && method === "GET")
    return { status: 200, body: options.llm.view() };
  if (path === "/llm/settings" && method === "PUT") {
    const apiKey = stringField(body, "apiKey");
    const structuredOutput = stringField(body, "structuredOutput");
    return {
      status: 200,
      body: options.llm.save({
        baseUrl: stringField(body, "baseUrl") ?? "",
        model: stringField(body, "model") ?? "",
        ...(apiKey ? { apiKey } : {}),
        ...(structuredOutput ? { structuredOutput: structuredOutput as StructuredOutput } : {}),
      }),
    };
  }
  if (path === "/llm/settings" && method === "DELETE") {
    return { status: 200, body: options.llm.remove() };
  }
  if (path === "/multica/settings" && method === "GET") {
    return { status: 200, body: options.multica.view() };
  }
  if (path === "/multica/settings" && method === "DELETE") {
    await options.multica.remove();
    return { status: 204 };
  }
  if (path === "/multica/workspaces" && method === "POST") {
    const token = stringField(body, "token");
    return { status: 200, body: { workspaces: await options.multica.listWorkspaces(token) } };
  }
  if (path === "/multica/issues" && method === "POST") {
    const refs = issueRefs(body);
    if (!refs) return { status: 400, body: { error: "invalid_issue_refs" } };
    return { status: 200, body: { issues: await options.multica.issues(refs) } };
  }
  if (path === "/multica/dispatch/options" && method === "GET") {
    return { status: 200, body: await options.dispatcher.options() };
  }
  if (path === "/multica/dispatch/options" && method === "POST") {
    return {
      status: 200,
      body: await options.dispatcher.options(stringField(body, "workspaceId")),
    };
  }
  if (path === "/multica/dispatch/issues" && method === "POST") {
    const projectId = stringField(body, "projectId");
    if (!projectId) return { status: 400, body: { error: "invalid_dispatch" } };
    const query = stringField(body, "query");
    const workspaceId = stringField(body, "workspaceId");
    return {
      status: 200,
      body: {
        issues: await options.dispatcher.issues({
          projectId,
          ...(query ? { query } : {}),
          ...(workspaceId ? { workspaceId } : {}),
        }),
      },
    };
  }
  if (path === "/multica/dispatches" && method === "GET") {
    return { status: 200, body: { dispatches: await options.dispatcher.list() } };
  }
  if (path === "/multica/dispatches" && method === "POST") {
    const projectId = stringField(body, "projectId");
    const agentId = stringField(body, "agentId");
    const issueId = stringField(body, "issueId");
    const prompt = rawString(body, "prompt") ?? "";
    const attachments = dispatchAttachments(body);
    const workspaceId = stringField(body, "workspaceId");
    if (!(issueId || (projectId && agentId)) || !attachments) {
      return { status: 400, body: { error: "invalid_dispatch" } };
    }
    return {
      status: 200,
      body: {
        dispatch: await options.dispatcher.create({
          ...(issueId ? { issueId } : { projectId, agentId }),
          prompt,
          attachments,
          ...(workspaceId ? { workspaceId } : {}),
        }),
      },
    };
  }
  if (path === "/multica/uploads" && method === "POST") {
    const name = rawString(body, "name");
    const type = stringField(body, "type");
    const data = stringField(body, "data");
    if (name === undefined || !type || !data) {
      return { status: 400, body: { error: "invalid_dispatch" } };
    }
    return {
      status: 200,
      body: {
        attachment: await options.dispatcher.upload(
          { name, type, data },
          stringField(body, "workspaceId"),
        ),
      },
    };
  }
  if (path === "/multica/dispatches/lookup" && method === "POST") {
    const id = stringField(body, "id");
    if (!id) return { status: 400, body: { error: "invalid_dispatch" } };
    return { status: 200, body: { dispatch: await options.dispatcher.lookup(id) } };
  }
  if (path === "/multica/dispatches/cancel" && method === "POST") {
    const id = stringField(body, "id");
    if (!id) return { status: 400, body: { error: "invalid_dispatch" } };
    return { status: 200, body: { dispatch: await options.dispatcher.cancel(id) } };
  }
  if (path === "/multica/settings" && method === "PUT") {
    const token = stringField(body, "token");
    const workspaceIds = workspaceIdList(body);
    if (!workspaceIds?.length) {
      return { status: 400, body: { error: "invalid_multica_settings" } };
    }
    return { status: 200, body: await options.multica.save(token, workspaceIds) };
  }
  return { status: 404, body: { error: "not_found" } };
}

function cors(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Access is gated by the local key, not the origin (Tauri webviews use per-platform origins).
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  // Chrome's Private Network Access preflight for a loopback target.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function send(res: http.ServerResponse, { status, body }: SettingsResult): true {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return true;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
}

function stringField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `workspaceIds` (non-empty strings), else an older app's single `workspaceId`; undefined when malformed. */
function workspaceIdList(body: unknown): string[] | undefined {
  const list =
    body && typeof body === "object"
      ? (body as { workspaceIds?: unknown }).workspaceIds
      : undefined;
  if (list === undefined) {
    const one = stringField(body, "workspaceId");
    return one ? [one] : undefined;
  }
  if (!Array.isArray(list) || !list.every((id) => typeof id === "string" && id.trim())) {
    return undefined;
  }
  return list.map((id: string) => id.trim());
}

/** `{ issues: [{ workspaceId, issueId }] }`, at most `MAX_ISSUE_REFS`; undefined when malformed. */
function issueRefs(body: unknown): { workspaceId: string; issueId: string }[] | undefined {
  const list = body && typeof body === "object" ? (body as { issues?: unknown }).issues : undefined;
  if (!Array.isArray(list) || list.length > MAX_ISSUE_REFS) return undefined;
  const refs: { workspaceId: string; issueId: string }[] = [];
  for (const item of list) {
    const workspaceId = stringField(item, "workspaceId");
    const issueId = stringField(item, "issueId");
    if (!workspaceId || !issueId) return undefined;
    refs.push({ workspaceId, issueId });
  }
  return refs;
}

/** A dispatch's `attachments` (none when absent); undefined when malformed. */
function dispatchAttachments(body: unknown): DispatchAttachment[] | undefined {
  const list =
    body && typeof body === "object" ? (body as { attachments?: unknown }).attachments : undefined;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return undefined;
  const attachments: DispatchAttachment[] = [];
  for (const item of list) {
    const id = stringField(item, "id");
    const filename = rawString(item, "filename");
    const markdownUrl = stringField(item, "markdownUrl");
    if (!id || filename === undefined || !markdownUrl) return undefined;
    attachments.push({ id, filename, markdownUrl });
  }
  return attachments;
}

/** A passphrase is kept exactly as typed (spaces count). */
function rawString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}
