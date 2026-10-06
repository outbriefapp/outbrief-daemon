import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BriefLanguage, isBriefLanguage } from "./brief/language.ts";
import { parseKey } from "./e2e/crypto.ts";
import { DEFAULT_LOCAL_PORT, outbriefHome } from "./home.ts";
import { type LlmEndpoint, STRUCTURED_OUTPUTS, type StructuredOutput } from "./llm/client.ts";

export { DEFAULT_LOCAL_PORT, outbriefHome } from "./home.ts";

/** Multica API origin; OUTBRIEF_MULTICA_API_URL overrides it (e.g. a self-hosted Multica). */
export function multicaApiUrl(): string {
  return process.env.OUTBRIEF_MULTICA_API_URL?.trim() || "https://api.multica.ai";
}

/** A Multica workspace the daemon listens to. */
export interface MulticaWorkspaceRef {
  id: string;
  name: string;
}

/**
 * The user's Multica token and workspaces, set from the app's settings. It never leaves this
 * machine: the daemon listens to every workspace and posts replies itself.
 */
export interface MulticaSettings {
  /** Personal access token (mul_…). */
  token: string;
  /** At least one; the first is where the app dispatches by default. */
  workspaces: MulticaWorkspaceRef[];
  updatedAt: string;
}

/** The OpenAI-compatible endpoint the daemon generates briefs with, set in the app. */
export interface LlmChannelConfig {
  /** e.g. "https://ai-gateway.vercel.sh/v1". */
  baseUrl: string;
  apiKey: string;
  /** Provider model id, e.g. "google/gemini-3.8-flash". */
  model: string;
  /** Per-call deadline; default 30 s. */
  timeoutMs?: number;
  /** Sent as `reasoning_effort` only when set (Vercel turns thinking ON for any explicit effort). */
  reasoningEffort?: string;
  /** How the endpoint returns the brief JSON (see `StructuredOutput`); default json_schema. */
  structuredOutput?: StructuredOutput;
}

/**
 * The end-to-end key (outbrief-server ADR 0007): reports are sealed with it before they reach the
 * server, replies opened with it. `random` is generated on first start; `passphrase` is derived
 * from what the user typed (the passphrase itself is not stored).
 */
export interface E2eSettings {
  /** `obk1_…` (see `e2e.ts`). */
  key: string;
  source: "random" | "passphrase";
  updatedAt: string;
}

/** `llm` in daemon.json: the one endpoint set in the app (设置 → 大模型). */
export interface LlmConfig {
  primary: LlmChannelConfig;
}

/** `brief` in daemon.json, set from the app (设置 → 语音 → 汇报语言). */
export interface BriefConfig {
  language: BriefLanguage;
}

const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/**
 * `~/.outbrief/daemon.json`. Permission settings live only here: the server never decides how an
 * agent may run on this machine.
 */
export interface DaemonConfig {
  serverUrl: string;
  /** Machine token from `outbrief-daemon login` (`obm_…`); revocable on its own. */
  token: string;
  machineId: string;
  machineName: string;
  /** Hooks post reports to http://127.0.0.1:<localPort>. */
  localPort: number;
  claude: {
    /** `claude --permission-mode`; default "acceptEdits". */
    permissionMode: string;
    /** Extra `--add-dir` directories. */
    addDirs: string[];
  };
  codex: {
    /** `codex exec -s`; default "workspace-write". */
    sandbox: string;
  };
  /** Absent until the user sets a Multica token in the app. */
  multica?: MulticaSettings;
  /** Absent only until the first `run`, which generates a random key. */
  e2e?: E2eSettings;
  /**
   * Brief generation, set from the app (设置 → 大模型). Without it every brief is "failed".
   */
  llm?: LlmConfig;
  /** Absent until the app sets a language: briefs follow this machine's locale. */
  brief?: BriefConfig;
}

export function configPath(): string {
  return join(outbriefHome(), "daemon.json");
}

function readConfigFile(): Partial<DaemonConfig> | undefined {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch {
    return undefined;
  }
  return JSON.parse(raw) as Partial<DaemonConfig>;
}

export function loadConfig(): DaemonConfig | undefined {
  const parsed = readConfigFile();
  if (!parsed) return undefined;
  const llm = parseLlmConfig(parsed.llm);
  const brief = parseBriefConfig(parsed.brief);
  const multica = multicaSettings(parsed.multica);
  if (!parsed.serverUrl || !parsed.token || !parsed.machineId) return undefined;
  return {
    serverUrl: parsed.serverUrl,
    token: parsed.token,
    machineId: parsed.machineId,
    machineName: parsed.machineName ?? parsed.machineId,
    localPort: parsed.localPort ?? DEFAULT_LOCAL_PORT,
    claude: {
      permissionMode: parsed.claude?.permissionMode ?? "acceptEdits",
      addDirs: parsed.claude?.addDirs ?? [],
    },
    codex: { sandbox: parsed.codex?.sandbox ?? "workspace-write" },
    ...(multica ? { multica } : {}),
    ...(isE2eSettings(parsed.e2e) ? { e2e: parsed.e2e } : {}),
    ...(llm ? { llm } : {}),
    ...(brief ? { brief } : {}),
  };
}

/** Just the `llm` section, for commands that need no pairing (`brief-eval`). */
export function loadLlmConfig(): LlmConfig | undefined {
  return parseLlmConfig(readConfigFile()?.llm);
}

/** Just the `brief` section, for commands that need no pairing (`brief-eval`). */
export function loadBriefConfig(): BriefConfig | undefined {
  return parseBriefConfig(readConfigFile()?.brief);
}

/** A malformed `brief` is ignored: briefs follow the machine's locale. */
function parseBriefConfig(value: unknown): BriefConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const language = (value as Record<string, unknown>).language;
  return isBriefLanguage(language) ? { language } : undefined;
}

/** `llm.primary` when well-formed; a malformed one is ignored (disabled), like `multica`. */
function parseLlmConfig(value: unknown): LlmConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const primary = (value as Record<string, unknown>).primary;
  return isLlmChannelConfig(primary) ? { primary } : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isLlmChannelConfig(value: unknown): value is LlmChannelConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    nonEmpty(v.baseUrl) &&
    URL.canParse(v.baseUrl.trim()) &&
    nonEmpty(v.apiKey) &&
    nonEmpty(v.model) &&
    (v.timeoutMs === undefined ||
      (typeof v.timeoutMs === "number" && Number.isInteger(v.timeoutMs) && v.timeoutMs > 0)) &&
    (v.reasoningEffort === undefined || nonEmpty(v.reasoningEffort)) &&
    (v.structuredOutput === undefined ||
      STRUCTURED_OUTPUTS.includes(v.structuredOutput as StructuredOutput))
  );
}

/** The endpoint briefs are generated with, default timeout applied; null when none is set. */
export function llmEndpoint(llm: LlmConfig | undefined): LlmEndpoint | null {
  if (!llm) return null;
  const { primary } = llm;
  const endpoint: LlmEndpoint = {
    baseUrl: primary.baseUrl.trim(),
    apiKey: primary.apiKey.trim(),
    model: primary.model.trim(),
    timeoutMs: primary.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    structuredOutput: primary.structuredOutput ?? "json_schema",
  };
  if (primary.reasoningEffort !== undefined) {
    endpoint.reasoningEffort = primary.reasoningEffort.trim();
  }
  return endpoint;
}

function isE2eSettings(value: unknown): value is E2eSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    parseKey(v.key) !== null &&
    (v.source === "random" || v.source === "passphrase") &&
    typeof v.updatedAt === "string"
  );
}

/**
 * `multica` when well-formed. One saved by a daemon that listened to a single workspace
 * (`workspaceId` / `workspaceName`) becomes a list of that one workspace.
 */
function multicaSettings(value: unknown): MulticaSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.token !== "string" || !v.token || typeof v.updatedAt !== "string") return undefined;
  const workspaces = Array.isArray(v.workspaces)
    ? v.workspaces.filter(isWorkspaceRef)
    : typeof v.workspaceId === "string" && typeof v.workspaceName === "string"
      ? [{ id: v.workspaceId, name: v.workspaceName }]
      : [];
  if (!workspaces.length) return undefined;
  return {
    token: v.token,
    workspaces: workspaces.map(({ id, name }) => ({ id, name })),
    updatedAt: v.updatedAt,
  };
}

function isWorkspaceRef(value: unknown): value is MulticaWorkspaceRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && !!v.id && typeof v.name === "string";
}

/**
 * Writes the config readable by this user only (it holds the machine, Multica and LLM keys). The
 * `llm` and `brief` sections on disk are kept verbatim, even when the loader ignored them as
 * malformed; `saveLlmConfig` / `saveBriefConfig` are their only writers.
 */
export function saveConfig(config: DaemonConfig): void {
  const { llm: _llm, brief: _brief, ...rest } = config;
  const onDisk = onDiskSections();
  writeConfigFile({ ...rest, ...onDisk });
}

/**
 * Replaces `llm` on disk with this endpoint (null removes it) and leaves the rest of the file
 * exactly as it is. Returns the `llm` section as loaded afterwards.
 */
export function saveLlmConfig(channel: LlmChannelConfig | null): LlmConfig | undefined {
  const { llm: _old, ...rest } = readConfigFile() ?? {};
  const llm = channel ? { primary: channel } : undefined;
  writeConfigFile(llm ? { ...rest, llm } : rest);
  return llm;
}

/** Replaces `brief` on disk and leaves the rest of the file exactly as it is. */
export function saveBriefConfig(brief: BriefConfig): void {
  writeConfigFile({ ...readConfigFile(), brief });
}

/** The app-owned sections as they are on disk. */
function onDiskSections(): Pick<Partial<DaemonConfig>, "llm" | "brief"> {
  let disk: Partial<DaemonConfig> | undefined;
  try {
    disk = readConfigFile();
  } catch {
    // Unreadable JSON is replaced wholesale, as before; it had no usable sections.
    return {};
  }
  return {
    ...(disk?.llm !== undefined ? { llm: disk.llm } : {}),
    ...(disk?.brief !== undefined ? { brief: disk.brief } : {}),
  };
}

function writeConfigFile(data: unknown): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
