import * as http from "node:http";
import { AgentEventInput, MAX_REPORT_CHARS } from "./brief/schema.ts";
import type { DaemonConfig } from "./config.ts";
import type { Outbox } from "./outbox.ts";
import type { AgentKind, StateStore } from "./state.ts";
import { errorText } from "./util.ts";

/** Handles a request it owns and resolves true; false leaves it to the routes below. */
export type ExtraRoutes = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

export function startListener(
  config: Pick<DaemonConfig, "localPort">,
  state: StateStore,
  outbox: Pick<Outbox, "add">,
  log: (msg: string) => void,
  extra?: ExtraRoutes,
): { port: number; close: () => void } {
  const server = http.createServer(async (req, res) => {
    if (extra && (await extra(req, res))) return;
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/report") {
      const refused = refuseReport(req, config.localPort);
      if (refused) {
        log(`[listener] refused report: ${refused.error}`);
        res.writeHead(refused.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: refused.error }));
        return;
      }
      const dryRun = url.searchParams.get("dryRun") === "1";
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REPORT_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ error: "too_large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        handleReport(Buffer.concat(chunks).toString("utf8"), dryRun, state, outbox, log, res);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(config.localPort, "127.0.0.1");
  log(`[listener] listening on 127.0.0.1:${config.localPort}`);

  return {
    port: config.localPort,
    close: () => {
      server.close();
    },
  };
}

/** `content` is at most `MAX_REPORT_CHARS` characters, 4 UTF-8 bytes at worst, plus the other fields. */
export const MAX_REPORT_BYTES = MAX_REPORT_CHARS * 4 + 64 * 1024;

/**
 * Only the hook, a local process, may report: every report rings the user's phone and records the
 * `sessionId → cwd` a reply is later run in. A web page can reach 127.0.0.1 with a no-preflight
 * `fetch`, so a browser request is refused by what it cannot hide: it always sends `Origin` on a
 * POST, cannot send `Content-Type: application/json` without a preflight this route never answers,
 * and a DNS-rebound page carries its own name in `Host`.
 */
function refuseReport(
  req: http.IncomingMessage,
  port: number,
): { status: number; error: string } | undefined {
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
    return { status: 403, error: "forbidden_host" };
  if (req.headers.origin !== undefined) return { status: 403, error: "forbidden_origin" };
  const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "json_required" };
  return undefined;
}

/**
 * Remembers the session's cwd, persists the report in the outbox and answers 202 right away: the
 * hook gives up after 5 s, while the brief takes 5–60 s and is generated in the background.
 *
 * `dryRun` (`POST /report?dryRun=1`) only validates and echoes the report: nothing is remembered or
 * queued, so it never rings. Every real report becomes a call on the user's phone (YOUT-201).
 */
function handleReport(
  body: string,
  dryRun: boolean,
  state: StateStore,
  outbox: Pick<Outbox, "add">,
  log: (msg: string) => void,
  res: http.ServerResponse,
): void {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }
  // Checked here, not by the server: a report the server would refuse must not be acknowledged.
  const parsed = AgentEventInput.safeParse(json);
  if (!parsed.success) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_event", issues: parsed.error.issues }));
    return;
  }
  const input = parsed.data;

  if (dryRun) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dryRun: true, event: input }));
    log(`[listener] dry-run report source=${input.source}: validated, not queued (no call)`);
    return;
  }

  // Persist session record so run.ts can look up cwd later.
  if (input.sessionId && input.cwd) {
    const agent: AgentKind = input.source.startsWith("codex") ? "codex" : "claude-code";
    state.rememberSession(input.sessionId, {
      agent,
      cwd: input.cwd,
      updatedAt: input.occurredAt ?? new Date().toISOString(),
    });
  }

  try {
    outbox.add({ kind: "event", input });
  } catch (err) {
    const msg = errorText(err);
    log(`[listener] could not queue report: ${msg}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
    return;
  }
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ accepted: true }));
  log(`[listener] accepted report source=${input.source} session=${input.sessionId ?? "-"}`);
}
