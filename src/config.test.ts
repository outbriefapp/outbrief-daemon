import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configPath,
  llmEndpoint,
  loadConfig,
  loadLlmConfig,
  saveBriefConfig,
  saveConfig,
  saveLlmConfig,
} from "./config.ts";

const previousHome = process.env.OUTBRIEF_HOME;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbrief-config-"));
  process.env.OUTBRIEF_HOME = dir;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OUTBRIEF_HOME;
  else process.env.OUTBRIEF_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

const PAIRED = { serverUrl: "http://server.test", token: "obm_machine", machineId: "m1" };

function write(value: unknown): void {
  writeFileSync(configPath(), JSON.stringify(value));
}

describe("llm config", () => {
  it("is absent without an llm section: briefs fail", () => {
    write(PAIRED);
    expect(loadConfig()?.llm).toBeUndefined();
    expect(llmEndpoint(loadConfig()?.llm)).toBeNull();
  });

  it("uses llm.primary with the default timeout", () => {
    write({
      ...PAIRED,
      llm: {
        primary: {
          baseUrl: "http://127.0.0.1:8080/v1",
          apiKey: "k1",
          model: "gemini-3.8-flash-high(low)",
          reasoningEffort: "none",
        },
      },
    });
    expect(llmEndpoint(loadConfig()?.llm)).toEqual({
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "k1",
      model: "gemini-3.8-flash-high(low)",
      timeoutMs: 30_000,
      reasoningEffort: "none",
      structuredOutput: "json_schema",
    });
  });

  it("ignores an endpoint that misses baseUrl, apiKey or model, or is malformed", () => {
    for (const primary of [
      { baseUrl: "https://a.test/v1", apiKey: "", model: "m" },
      { baseUrl: "not a url", apiKey: "k", model: "m" },
      { baseUrl: "https://a.test/v1", apiKey: "k", model: "m", timeoutMs: "fast" },
      { baseUrl: "https://a.test/v1", apiKey: "k", model: "m", structuredOutput: "xml" },
    ]) {
      write({ ...PAIRED, llm: { primary } });
      expect(loadConfig()?.llm).toBeUndefined();
    }
  });

  it("is readable without pairing, for brief-eval", () => {
    write({ llm: { primary: { baseUrl: "https://a.test/v1", apiKey: "k", model: "m" } } });
    expect(loadConfig()).toBeUndefined();
    expect(llmEndpoint(loadLlmConfig())?.model).toBe("m");
  });

  it("keeps the llm section verbatim when the daemon saves its config", () => {
    const llm = { primary: { baseUrl: "https://a.test/v1", apiKey: "k", model: "m" } };
    write({ ...PAIRED, llm });
    const config = loadConfig();
    if (!config) throw new Error("config should load");
    config.multica = {
      token: "mul_x",
      workspaceId: "ws-1",
      workspaceName: "w",
      updatedAt: "2026-09-28T00:00:00Z",
    };
    saveConfig(config);
    const saved = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(saved.llm).toEqual(llm);
    expect(saved.multica.workspaceId).toBe("ws-1");
  });

  it("replaces llm on disk, dropping a hand-set fallback, and leaves the rest of the file alone", () => {
    const fallback = { baseUrl: "https://b.test/v1", apiKey: "k2", model: "m2" };
    write({ ...PAIRED, localPort: 8791, llm: { fallback } });
    const primary = { baseUrl: "https://a.test/v1", apiKey: "k1", model: "m1" };
    expect(saveLlmConfig(primary)).toEqual({ primary });
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
      ...PAIRED,
      localPort: 8791,
      llm: { primary },
    });
    expect(saveLlmConfig(null)).toBeUndefined();
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ ...PAIRED, localPort: 8791 });
  });
});

describe("brief config", () => {
  it("keeps the language set in the app across saves of the rest of the config", () => {
    write(PAIRED);
    expect(loadConfig()?.brief).toBeUndefined();
    const config = loadConfig();
    if (!config) throw new Error("config should load");
    saveBriefConfig({ language: "ja-JP" });
    // A section saved from an older in-memory copy must not undo the language.
    saveConfig(config);
    expect(loadConfig()?.brief).toEqual({ language: "ja-JP" });
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
      ...PAIRED,
      machineName: "m1",
      localPort: 8790,
      claude: { permissionMode: "acceptEdits", addDirs: [] },
      codex: { sandbox: "workspace-write" },
      brief: { language: "ja-JP" },
    });
  });

  it("ignores an unknown language", () => {
    write({ ...PAIRED, brief: { language: "xx" } });
    expect(loadConfig()?.brief).toBeUndefined();
  });
});
