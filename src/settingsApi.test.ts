import { once } from "node:events";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BriefSettings } from "./brief/settings.ts";
import type { BriefConfig, DaemonConfig } from "./config.ts";
import {
  formatKey,
  generateKey,
  openJson,
  parseKey,
  sealJson,
  settingsAad,
  settingsResultAad,
} from "./e2e/crypto.ts";
import { E2eKeyring } from "./e2e/keyring.ts";
import { LlmSettings } from "./llm/settings.ts";
import { type Dispatch, DispatchError } from "./multica/dispatch.ts";
import { MulticaSettingsError } from "./multica/service.ts";
import { createSettingsApi } from "./settingsApi.ts";

let server: http.Server | undefined;
afterEach(async () => {
  server?.close();
  server = undefined;
});

async function start() {
  const calls: string[] = [];
  let port = 0;
  const saved: DaemonConfig[] = [];
  const keyring = new E2eKeyring(
    {} as DaemonConfig,
    (c) => saved.push(structuredClone(c)),
    () => undefined,
  );
  const llm = new LlmSettings({
    llm: undefined,
    save: (channel) => (channel ? { primary: channel } : undefined),
    client: { log: () => undefined },
    log: () => undefined,
  });
  const briefSaved: BriefConfig[] = [];
  const brief = new BriefSettings({
    brief: undefined,
    save: (b) => briefSaved.push(b),
    log: () => undefined,
    system: () => "zh-CN",
  });
  const handle = createSettingsApi({
    dispatcher: {
      options: async (workspaceId) => ({
        projects: [{ id: workspaceId ?? "p1", title: "outbrief" }],
        agents: [],
      }),
      create: async (input) => {
        if (input.agentId === "offline") {
          throw new DispatchError("agent_unavailable", "runtime is offline");
        }
        if (!input.prompt.trim() && !input.attachments?.length)
          throw new DispatchError("invalid_dispatch");
        const images = input.attachments?.map((a) => a.id).join(",");
        if (input.issueId) {
          calls.push(`comment ${input.issueId} ${input.prompt}`);
          return { id: "c-1", kind: "comment", state: "created" } as Dispatch;
        }
        calls.push(
          `dispatch ${input.projectId} ${input.agentId} ${input.prompt}${images ? ` [${images}]` : ""}${input.workspaceId ? ` in ${input.workspaceId}` : ""}`,
        );
        return { id: "task-1", state: "creating" } as Dispatch;
      },
      issues: async (input) => {
        calls.push(
          `issues ${input.projectId} ${input.query ?? ""}${input.statuses ? ` [${input.statuses.join(",")}]` : ""}${input.workspaceId ? ` in ${input.workspaceId}` : ""}`,
        );
        return [
          { id: "i1", identifier: "OUTB-1", title: "旧需求", status: "todo", priority: "none" },
        ];
      },
      statuses: async (workspaceId) => [
        { key: "backlog", name: workspaceId ?? "Backlog" },
        { key: "in_progress", name: "In Progress" },
      ],
      upload: async (image, workspaceId) => {
        if (!image.type.startsWith("image/")) throw new DispatchError("invalid_dispatch");
        if (workspaceId) calls.push(`upload in ${workspaceId}`);
        return { id: "att-1", filename: image.name, markdownUrl: "https://m.test/att-1" };
      },
      list: async () => [],
      lookup: async (id) => {
        throw new DispatchError("dispatch_not_found", id);
      },
      cancel: async (id) => ({ id, state: "cancelled" }) as Dispatch,
    },
    e2e: keyring,
    llm,
    brief,
    get port() {
      return port;
    },
    log: () => undefined,
    localKey: "good-token",
    pairing: async () => {
      calls.push("pairing");
      return {
        serverUrl: "https://outbrief.test",
        code: "123456",
        expiresAt: "2026-09-29T00:10:00.000Z",
        key: keyring.view().key,
        link: "outbrief://pair?…",
      };
    },
    multica: {
      view: () => ({
        settings: null,
        status: { configured: false, connected: false, error: null, workspaces: [] },
      }),
      listWorkspaces: async (token) => {
        if (token !== "mul_good") throw new MulticaSettingsError("invalid_multica_token");
        return [{ id: "ws-1", name: "youtube-dubbing" }];
      },
      save: async (_token, workspaceIds) => {
        if (workspaceIds.includes("ws-9")) throw new MulticaSettingsError("workspace_not_found");
        calls.push(`save ${workspaceIds.join(",")}`);
        return {
          settings: null,
          status: { configured: true, connected: false, error: null, workspaces: [] },
        };
      },
      remove: async () => undefined,
      issues: async (refs) =>
        refs.map((r) => ({
          ...r,
          issueIdentifier: "YOUT-7",
          issueTitle: "修复登录跳转",
          projectId: null,
          projectTitle: null,
          issuePriority: "none",
          issueUpdatedAt: "2026-09-28T00:00:00Z",
        })),
    },
  });
  server = http.createServer(async (req, res) => {
    if (!(await handle.handle(req, res))) {
      res.writeHead(418);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}, bearer = "good-token") =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    });
  return { call, calls, base, saved, briefSaved, keyring, relay: handle.relay };
}

describe("settings API", () => {
  it("needs this machine's local key, not a server token", async () => {
    const { call } = await start();
    expect((await call("/multica/settings", {}, "bad-token")).status).toBe(401);
    expect((await call("/multica/settings", {}, "good-token-but-longer")).status).toBe(401);
    expect((await call("/multica/settings")).status).toBe(200);
  });

  it("hands the app on this machine a pairing code with this machine's key", async () => {
    const { call, calls, keyring } = await start();
    expect((await call("/local/pairing", { method: "POST" }, "bad-token")).status).toBe(401);
    const res = await call("/local/pairing", { method: "POST" });
    expect(await res.json()).toMatchObject({ code: "123456", key: keyring.view().key });
    expect(calls).toEqual(["pairing"]);
  });

  it("maps token problems to 422 and leaves other paths alone", async () => {
    const { call, calls } = await start();
    const bad = await call("/multica/workspaces", {
      method: "POST",
      body: JSON.stringify({ token: "mul_bad" }),
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "invalid_multica_token" });
    const ok = await call("/multica/workspaces", {
      method: "POST",
      body: JSON.stringify({ token: " mul_good " }),
    });
    expect(await ok.json()).toEqual({ workspaces: [{ id: "ws-1", name: "youtube-dubbing" }] });
    const put = await call("/multica/settings", {
      method: "PUT",
      body: JSON.stringify({ token: "mul_good", workspaceId: "ws-9" }),
    });
    expect(await put.json()).toEqual({ error: "workspace_not_found" });
    expect((await call("/multica/settings", { method: "PUT", body: "{}" })).status).toBe(400);
    const save = (body: unknown) =>
      call("/multica/settings", { method: "PUT", body: JSON.stringify(body) });
    expect((await save({ token: "mul_good", workspaceIds: [] })).status).toBe(400);
    expect((await save({ token: "mul_good", workspaceIds: ["ws-1", 2] })).status).toBe(400);
    expect((await save({ token: "mul_good", workspaceIds: ["ws-1", " ws-2 "] })).status).toBe(200);
    // An older app sends the one workspace it knows.
    expect((await save({ token: "mul_good", workspaceId: "ws-1" })).status).toBe(200);
    // Without a token the saved one is kept.
    expect((await save({ workspaceIds: ["ws-2"] })).status).toBe(200);
    expect(calls).toEqual(["save ws-1,ws-2", "save ws-1", "save ws-2"]);
    expect((await call("/multica/settings", { method: "DELETE" })).status).toBe(204);
    expect((await call("/report")).status).toBe(418);
  });

  it("looks up the issues of past calls for the app's call list", async () => {
    const { call } = await start();
    const ok = await call("/multica/issues", {
      method: "POST",
      body: JSON.stringify({ issues: [{ workspaceId: "ws-1", issueId: "issue-1" }] }),
    });
    expect(await ok.json()).toEqual({
      issues: [expect.objectContaining({ workspaceId: "ws-1", issueId: "issue-1" })],
    });
    const malformed = await call("/multica/issues", {
      method: "POST",
      body: JSON.stringify({ issues: [{ workspaceId: "ws-1" }] }),
    });
    expect(malformed.status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ workspaceId: "w", issueId: `i${i}` }));
    const big = await call("/multica/issues", {
      method: "POST",
      body: JSON.stringify({ issues: tooMany }),
    });
    expect(big.status).toBe(400);
  });

  it("dispatches what the user said and explains Multica's refusal", async () => {
    const { call, calls } = await start();
    expect(await (await call("/multica/dispatch/options")).json()).toEqual({
      projects: [{ id: "p1", title: "outbrief" }],
      agents: [],
    });
    const post = (body: unknown) =>
      call("/multica/dispatches", { method: "POST", body: JSON.stringify(body) });
    const ok = await post({ projectId: "p1", agentId: "a1", prompt: "加一个按钮" });
    expect(await ok.json()).toEqual({ dispatch: { id: "task-1", state: "creating" } });
    expect(calls).toEqual(["dispatch p1 a1 加一个按钮"]);
    const offline = await post({ projectId: "p1", agentId: "offline", prompt: "x" });
    expect(offline.status).toBe(422);
    expect(await offline.json()).toEqual({
      error: "agent_unavailable",
      message: "runtime is offline",
    });
    expect((await post({ projectId: "p1", agentId: "a1" })).status).toBe(400);
    // An image is uploaded on its own, then sent with the dispatch; images alone are a request.
    const upload = (body: unknown) =>
      call("/multica/uploads", { method: "POST", body: JSON.stringify(body) });
    const uploaded = await upload({ name: "shot.png", type: "image/png", data: "iVBORw0KGgo=" });
    const { attachment } = (await uploaded.json()) as { attachment: unknown };
    expect(attachment).toEqual({
      id: "att-1",
      filename: "shot.png",
      markdownUrl: "https://m.test/att-1",
    });
    expect((await upload({ name: "a.pdf", type: "application/pdf", data: "eA==" })).status).toBe(
      400,
    );
    expect((await upload({ name: "a.png", type: "image/png" })).status).toBe(400);
    expect((await post({ projectId: "p1", agentId: "a1", attachments: [attachment] })).status).toBe(
      200,
    );
    expect(calls.at(-1)).toBe("dispatch p1 a1  [att-1]");
    // Another listened workspace is picked by id; without one the first is used.
    const other = await call("/multica/dispatch/options", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "ws-2" }),
    });
    expect(await other.json()).toEqual({
      projects: [{ id: "ws-2", title: "outbrief" }],
      agents: [],
    });
    await upload({ name: "a.png", type: "image/png", data: "eA==", workspaceId: "ws-2" });
    await post({ projectId: "p1", agentId: "a1", prompt: "x", workspaceId: "ws-2" });
    expect(calls.slice(-2)).toEqual(["upload in ws-2", "dispatch p1 a1 x in ws-2"]);
    expect(
      (await post({ projectId: "p1", agentId: "a1", prompt: "x", attachments: "no" })).status,
    ).toBe(400);
    expect(
      (await post({ projectId: "p1", agentId: "a1", prompt: "x", attachments: [{ id: "a" }] }))
        .status,
    ).toBe(400);
    const lookup = await call("/multica/dispatches/lookup", {
      method: "POST",
      body: JSON.stringify({ id: "nope" }),
    });
    expect(lookup.status).toBe(422);
    const cancel = await call("/multica/dispatches/cancel", {
      method: "POST",
      body: JSON.stringify({ id: "task-1" }),
    });
    expect(await cancel.json()).toEqual({ dispatch: { id: "task-1", state: "cancelled" } });
    expect(await (await call("/multica/dispatches")).json()).toEqual({ dispatches: [] });
  });

  it("lists a project's issues and comments on the picked one (OUTB-61)", async () => {
    const { call, calls } = await start();
    const issues = await call("/multica/dispatch/issues", {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", query: " 登录 ", workspaceId: "ws-2" }),
    });
    expect(await issues.json()).toEqual({
      issues: [
        { id: "i1", identifier: "OUTB-1", title: "旧需求", status: "todo", priority: "none" },
      ],
    });
    expect(calls).toEqual(["issues p1 登录 in ws-2"]);
    // Several statuses at once: issues in any of them.
    await call("/multica/dispatch/issues", {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", statuses: ["backlog", " in_progress "] }),
    });
    expect(calls.at(-1)).toBe("issues p1  [backlog,in_progress]");
    const badStatuses = await call("/multica/dispatch/issues", {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", statuses: "backlog" }),
    });
    expect(badStatuses.status).toBe(400);
    const statuses = await call("/multica/dispatch/statuses", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "ws-2" }),
    });
    expect(await statuses.json()).toEqual({
      statuses: [
        { key: "backlog", name: "ws-2" },
        { key: "in_progress", name: "In Progress" },
      ],
    });
    const noProject = await call("/multica/dispatch/issues", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(noProject.status).toBe(400);
    // With an issue picked, neither a project nor an agent is needed.
    const comment = await call("/multica/dispatches", {
      method: "POST",
      body: JSON.stringify({ issueId: "i1", prompt: "补充一下" }),
    });
    expect(await comment.json()).toEqual({
      dispatch: { id: "c-1", kind: "comment", state: "created" },
    });
    expect(calls.at(-1)).toBe("comment i1 补充一下");
    const nothing = await call("/multica/dispatches", {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", prompt: "x" }),
    });
    expect(nothing.status).toBe(400);
  });

  it("answers the CORS preflight and refuses a foreign Host header", async () => {
    const { base } = await start();
    const preflight = await fetch(`${base}/multica/settings`, {
      method: "OPTIONS",
      headers: { Origin: "tauri://localhost" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    const rebound = await new Promise<number>((resolve) => {
      const url = new URL(base);
      http
        .get(
          {
            host: url.hostname,
            port: url.port,
            path: "/multica/settings",
            headers: { Host: "evil.test", Authorization: "Bearer good-token" },
          },
          (res) => resolve(res.statusCode ?? 0),
        )
        .end();
    });
    expect(rebound).toBe(403);
  });

  it("shares this machine's end-to-end key with the app and lets it be replaced", async () => {
    const { call, saved } = await start();
    expect((await call("/e2e/key", {}, "bad-token")).status).toBe(401);
    const first = (await (await call("/e2e/key")).json()) as { key: string; keyId: string };
    expect(first).toMatchObject({ key: expect.stringMatching(/^obk1_/), source: "random" });
    expect(saved.at(-1)?.e2e?.key).toBe(first.key);

    const short = await call("/e2e/key", {
      method: "PUT",
      body: JSON.stringify({ passphrase: "short" }),
    });
    expect(short.status).toBe(422);
    expect(await short.json()).toEqual({ error: "passphrase_too_short" });

    const phrase = await call("/e2e/key", {
      method: "PUT",
      body: JSON.stringify({ passphrase: "correct horse battery" }),
    });
    expect(await phrase.json()).toMatchObject({
      key: "obk1_Lx4pmWArsLrCqKgNPE7sIYbZh5EQ66DRTMvbmmmmsQY",
      source: "passphrase",
    });
    // The passphrase itself is never stored, only the key derived from it.
    expect(JSON.stringify(saved)).not.toContain("correct horse");

    const bad = await call("/e2e/key", { method: "PUT", body: JSON.stringify({ key: "obk1_x" }) });
    expect(await bad.json()).toEqual({ error: "invalid_key" });
    const copied = await call("/e2e/key", {
      method: "PUT",
      body: JSON.stringify({ key: first.key }),
    });
    expect(await copied.json()).toMatchObject({ key: first.key, keyId: first.keyId });
  });

  it("sets the brief LLM from the app without ever returning the key", async () => {
    const { call } = await start();
    expect(await (await call("/llm/settings")).json()).toEqual({ channel: null });
    const noKey = await call("/llm/settings", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://api.test/v1", model: "m" }),
    });
    expect(noKey.status).toBe(422);
    expect(await noKey.json()).toEqual({ error: "llm_key_required" });
    const bad = await call("/llm/settings", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "api.test", apiKey: "sk-1234567890", model: "m" }),
    });
    expect(await bad.json()).toEqual({ error: "invalid_llm_settings" });

    const put = await call("/llm/settings", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://api.test/v1", apiKey: "sk-1234567890", model: "m" }),
    });
    const body = await put.text();
    expect(JSON.parse(body)).toEqual({
      channel: {
        baseUrl: "https://api.test/v1",
        model: "m",
        keyHint: "sk-…7890",
        structuredOutput: "json_schema",
      },
    });
    expect(body).not.toContain("sk-1234567890");
    const removed = await call("/llm/settings", { method: "DELETE" });
    expect(await removed.json()).toEqual({ channel: null });
  });

  it("sets the language briefs are written in", async () => {
    const { call, briefSaved } = await start();
    expect(await (await call("/brief/language")).json()).toEqual({
      language: "zh-CN",
      source: "system",
    });
    const bad = await call("/brief/language", {
      method: "PUT",
      body: JSON.stringify({ language: "xx" }),
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "invalid_language" });
    const put = await call("/brief/language", {
      method: "PUT",
      body: JSON.stringify({ language: "en-US" }),
    });
    expect(await put.json()).toEqual({ language: "en-US", source: "app" });
    // The app sets it on every start; the same language is not written again.
    await call("/brief/language", { method: "PUT", body: JSON.stringify({ language: "en-US" }) });
    expect(briefSaved).toEqual([{ language: "en-US" }]);
  });

  it("answers relayed requests sealed with the end-to-end key, but never the key itself", async () => {
    const { relay, keyring, calls } = await start();
    const app = await appKey(keyring.view().key);
    const ask = async (request: unknown) => {
      const requestId = crypto.randomUUID();
      const sealed = await app.seal(settingsAad(requestId), request);
      return app.open(settingsResultAad(requestId), await relay(requestId, sealed));
    };

    expect(
      await ask({ method: "PUT", path: "/brief/language", body: { language: "en-US" } }),
    ).toEqual({ status: 200, body: { language: "en-US", source: "app" } });
    expect(await ask({ method: "DELETE", path: "/multica/settings" })).toEqual({ status: 204 });
    for (const path of ["/e2e/key", "/local/pairing"]) {
      expect(await ask({ method: path === "/e2e/key" ? "GET" : "POST", path })).toEqual({
        status: 403,
        body: { error: "not_relayed" },
      });
    }
    expect(calls).toEqual([]);
    expect(await ask({ path: "/llm/settings" })).toEqual({
      status: 400,
      body: { error: "invalid_settings_request" },
    });
  });

  it("tells an app with another key that it cannot open the request", async () => {
    const { relay, keyring } = await start();
    const other = await appKey(formatKey(generateKey()));
    const requestId = crypto.randomUUID();
    const sealed = await other.seal(settingsAad(requestId), {
      method: "GET",
      path: "/llm/settings",
    });
    const answer = await relay(requestId, sealed);
    const mine = await appKey(keyring.view().key);
    expect(await mine.open(settingsResultAad(requestId), answer)).toEqual({
      status: 400,
      body: { error: "undecryptable_request" },
    });
  });
});

/** The app's side of the relay, with the same crypto as `e2e/crypto.ts`. */
async function appKey(text: string) {
  const key = parseKey(text);
  if (!key) throw new Error("bad key");
  return {
    seal: async (aad: string, value: unknown) => sealJson(key, aad, value),
    open: async (aad: string, sealed: string) => openJson(key, aad, sealed),
  };
}
