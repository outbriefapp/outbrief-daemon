import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  extractJsonMiddleware,
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
  Output,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";

/**
 * How the endpoint is made to return JSON matching the schema; the user picks it in the app and
 * checks it with 测试连接:
 * - `json_schema`: `response_format: json_schema` (structured outputs), enforced by the endpoint.
 * - `json_object`: for endpoints without json_schema (DeepSeek, Ollama, Claude's OpenAI
 *   compatibility…): the schema goes into the system prompt, the request asks for
 *   `response_format: json_object`, a markdown fence around the answer is stripped, and the
 *   answer is validated against the same schema.
 */
export type StructuredOutput = "json_schema" | "json_object";

export const STRUCTURED_OUTPUTS: readonly StructuredOutput[] = ["json_schema", "json_object"];

/** Why a call failed (logged as `reason`). */
export type FailureReason = "error" | "timeout" | "content_filter" | "schema";

/** The OpenAI-compatible endpoint set in the app (设置 → 大模型), `llm.primary` in daemon.json. */
export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
  /** Provider model id, e.g. "gemini-3.8-flash". */
  model: string;
  /** Per-attempt deadline. */
  timeoutMs: number;
  /** Sent as `reasoning_effort`; omitted entirely when undefined. */
  reasoningEffort?: string;
  structuredOutput: StructuredOutput;
  /** Test seam: replaces the HTTP client (the fake wire in tests). */
  fetch?: typeof fetch;
}

export interface LlmRequest {
  /** System instructions chosen by the daemon. */
  system: string;
  prompt: string;
  /** Caller cancellation (daemon shutting down). */
  signal?: AbortSignal;
}

/** One log entry per call. */
export interface LlmCallLog {
  task: string;
  ok: boolean;
  durationMs: number;
  reason?: FailureReason;
  error?: string;
}

export interface LlmClientOptions {
  log?: (entry: LlmCallLog) => void;
}

/** No endpoint is configured: briefs fail without calling anything. */
export class LlmDisabledError extends Error {
  constructor() {
    super("这台电脑没有配置大模型（在 App「设置 → 大模型」里填写）");
  }
}

/** The endpoint failed one call. */
export class LlmFailedError extends Error {
  readonly reason: FailureReason;

  constructor(reason: FailureReason, cause: unknown) {
    super(`LLM call failed (${reason}): ${messageOf(cause)}`, { cause });
    this.reason = reason;
  }
}

/** A response that must not be used although the HTTP call itself succeeded. */
class RejectedResponseError extends Error {
  readonly reason: FailureReason;

  constructor(reason: FailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
  }
}

function reasonOf(err: unknown): FailureReason {
  if (err instanceof TimeoutError) return "timeout";
  if (err instanceof RejectedResponseError) return err.reason;
  if (NoObjectGeneratedError.isInstance(err)) {
    return err.finishReason === "content-filter" ? "content_filter" : "schema";
  }
  return "error";
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Structured calls to the one endpoint the user set in the app. A call fails when the endpoint
 * throws, answers non-2xx, times out, returns output that does not match the schema, or stops with
 * `content-filter`; the brief is then "failed" and clients read the raw report.
 */
export class LlmClient {
  readonly #endpoint: LlmEndpoint | null;
  readonly #model: LanguageModel | null;
  readonly #log: (entry: LlmCallLog) => void;

  constructor(endpoint: LlmEndpoint | null, { log }: LlmClientOptions = {}) {
    this.#endpoint = endpoint;
    this.#model = endpoint ? chatModel(endpoint) : null;
    this.#log = log ?? ((entry) => console.log(JSON.stringify({ msg: "llm_call", ...entry })));
  }

  /** False when no endpoint is configured; briefs then fail without an LLM call. */
  get available(): boolean {
    return this.#endpoint !== null;
  }

  /** Structured output validated against `schema`. */
  async generateObject<T>(task: string, schema: z.ZodType<T>, request: LlmRequest): Promise<T> {
    const endpoint = this.#endpoint;
    const model = this.#model;
    if (!endpoint || !model) throw new LlmDisabledError();
    const started = performance.now();
    const log = (entry: Omit<LlmCallLog, "task" | "durationMs">) =>
      this.#log({ task, durationMs: Math.round(performance.now() - started), ...entry });

    const timeout = new TimeoutError(endpoint.timeoutMs);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(timeout), endpoint.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, deadline.signal])
      : deadline.signal;
    try {
      const result = await generateText({
        model,
        instructions:
          endpoint.structuredOutput === "json_object"
            ? withSchema(request.system, schema)
            : request.system,
        prompt: request.prompt,
        output: Output.object({ schema }),
        providerOptions: {
          llm: {
            ...(endpoint.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: endpoint.reasoningEffort }),
            ...routingOptions(endpoint.baseUrl, endpoint.structuredOutput),
          },
        },
        abortSignal: signal,
        maxRetries: 0,
      });
      if (result.finishReason === "content-filter") {
        throw new RejectedResponseError("content_filter", "response blocked by content filter");
      }
      log({ ok: true });
      return result.output;
    } catch (err) {
      if (request.signal?.aborted) throw err;
      const error = deadline.signal.aborted ? timeout : err;
      const reason = reasonOf(error);
      log({ ok: false, reason, error: messageOf(error) });
      throw new LlmFailedError(reason, error);
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  }
}

/**
 * The chat model for an endpoint. Without json_schema the SDK asks for `json_object`; the fence
 * middleware turns a "```json … ```" answer back into plain JSON before it is parsed.
 */
function chatModel(endpoint: LlmEndpoint): LanguageModel {
  const model = createOpenAICompatible({
    name: "llm",
    baseURL: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    supportsStructuredOutputs: endpoint.structuredOutput === "json_schema",
    fetch: endpoint.fetch,
  }).chatModel(endpoint.model);
  return endpoint.structuredOutput === "json_schema"
    ? model
    : wrapLanguageModel({ model, middleware: extractJsonMiddleware() });
}

/**
 * Extra request fields a provider needs for the strategy. OpenRouter decides json_schema support per
 * upstream endpoint and only routes to ones that support it when asked to
 * (`provider.require_parameters`); otherwise a request can land on one that fails it.
 */
export function routingOptions(
  baseUrl: string,
  structuredOutput: StructuredOutput,
): Record<string, { require_parameters: true }> {
  const host = URL.canParse(baseUrl) ? new URL(baseUrl).hostname : "";
  return host === "openrouter.ai" && structuredOutput === "json_schema"
    ? { provider: { require_parameters: true } }
    : {};
}

/** The schema spelled out for an endpoint that does not enforce it (json_object mode). */
export function withSchema(system: string, schema: z.ZodType): string {
  const jsonSchema = JSON.stringify(
    z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  );
  return `${system}

输出格式：只输出一个 JSON 对象，不要输出任何其他文字，不要用 markdown 代码块包起来。这个 JSON 必须符合下面的 JSON Schema（字段名、类型、必填项都要一致）：
${jsonSchema}`;
}
