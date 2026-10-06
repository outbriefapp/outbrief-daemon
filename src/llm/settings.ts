import { type LlmChannelConfig, type LlmConfig, llmEndpoint } from "../config.ts";
import {
  LlmClient,
  type LlmClientOptions,
  STRUCTURED_OUTPUTS,
  type StructuredOutput,
} from "./client.ts";

/** The endpoint as the app sees it: never the key itself, only its hint. */
export interface LlmChannelView {
  baseUrl: string;
  model: string;
  /** "sk-…abcd". */
  keyHint: string;
  structuredOutput: StructuredOutput;
}

/** `GET /llm/settings`: the endpoint briefs are generated with right now, null when none. */
export interface LlmSettingsView {
  channel: LlmChannelView | null;
}

/** What the app saves; no `apiKey` keeps the saved key. */
export interface SaveLlmInput {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Default json_schema. */
  structuredOutput?: StructuredOutput;
}

export class LlmSettingsError extends Error {
  readonly code: "invalid_llm_settings" | "llm_key_required";

  constructor(code: LlmSettingsError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface LlmSettingsOptions {
  llm: LlmConfig | undefined;
  /** Writes `llm` to daemon.json (null removes it); returns `llm` as loaded afterwards. */
  save: (channel: LlmChannelConfig | null) => LlmConfig | undefined;
  client?: LlmClientOptions;
  log: (message: string) => void;
}

/** "sk-…abcd": enough to recognise a key without showing it (the app shows the same). */
export function keyHint(key: string): string {
  return key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "…";
}

/**
 * The daemon's LLM endpoint and the client built from it. The app sets it; saving takes effect for
 * the next brief, without a restart. Briefs already being generated finish with the client they
 * started with.
 */
export class LlmSettings {
  #llm: LlmConfig | undefined;
  #client: LlmClient;
  readonly #options: LlmSettingsOptions;

  constructor(options: LlmSettingsOptions) {
    this.#options = options;
    this.#llm = options.llm;
    this.#client = this.#build();
  }

  /** The client for the next brief. */
  get client(): LlmClient {
    return this.#client;
  }

  view(): LlmSettingsView {
    const channel = this.#llm?.primary;
    return {
      channel: channel
        ? {
            baseUrl: channel.baseUrl.trim(),
            model: channel.model.trim(),
            keyHint: keyHint(channel.apiKey.trim()),
            structuredOutput: channel.structuredOutput ?? "json_schema",
          }
        : null,
    };
  }

  /** Saves the endpoint; `reasoningEffort` / `timeoutMs` stay only for the same endpoint and model. */
  save(input: SaveLlmInput): LlmSettingsView {
    const baseUrl = input.baseUrl.trim();
    const model = input.model.trim();
    const structuredOutput = input.structuredOutput ?? "json_schema";
    if (
      !/^https?:\/\/[^/]/.test(baseUrl) ||
      !URL.canParse(baseUrl) ||
      !model ||
      !STRUCTURED_OUTPUTS.includes(structuredOutput)
    ) {
      throw new LlmSettingsError("invalid_llm_settings");
    }
    const current = this.#llm?.primary;
    const apiKey = input.apiKey?.trim() || current?.apiKey.trim();
    if (!apiKey) throw new LlmSettingsError("llm_key_required");
    const channel: LlmChannelConfig = { baseUrl, apiKey, model, structuredOutput };
    if (current && current.baseUrl.trim() === baseUrl && current.model.trim() === model) {
      if (current.timeoutMs !== undefined) channel.timeoutMs = current.timeoutMs;
      if (current.reasoningEffort !== undefined) channel.reasoningEffort = current.reasoningEffort;
    }
    this.#apply(this.#options.save(channel));
    this.#options.log(`[llm] set by the app: ${model} @ ${baseUrl} (${structuredOutput})`);
    return this.view();
  }

  /** Removes the endpoint: briefs fail and clients read the raw report. */
  remove(): LlmSettingsView {
    this.#apply(this.#options.save(null));
    this.#options.log("[llm] removed by the app");
    return this.view();
  }

  #apply(llm: LlmConfig | undefined): void {
    this.#llm = llm;
    this.#client = this.#build();
  }

  #build(): LlmClient {
    return new LlmClient(llmEndpoint(this.#llm), this.#options.client);
  }
}
