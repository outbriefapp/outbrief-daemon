/**
 * Test-only: a fake OpenAI-compatible wire. `LlmClient` runs its real AI SDK path; only `fetch` is
 * replaced, so request bodies and responses are the actual chat-completions JSON.
 */
import type { LlmEndpoint, StructuredOutput } from "./client.ts";

export interface FakeLlmRequest {
  /** Parsed chat-completions request body. */
  body: {
    model: string;
    stream?: boolean;
    reasoning_effort?: string;
    messages: { role: string; content: unknown }[];
    [key: string]: unknown;
  };
  signal: AbortSignal | undefined;
}

export type FakeLlmHandler = (request: FakeLlmRequest) => Response | Promise<Response>;

/** An endpoint whose HTTP traffic goes to `handler`. */
export function fakeEndpoint(
  handler: FakeLlmHandler,
  {
    timeoutMs = 2_000,
    reasoningEffort,
    structuredOutput = "json_schema",
  }: { timeoutMs?: number; reasoningEffort?: string; structuredOutput?: StructuredOutput } = {},
): LlmEndpoint {
  return {
    baseUrl: "http://llm.test/v1",
    apiKey: "test-key",
    model: "test-model",
    timeoutMs,
    structuredOutput,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    fetch: async (_url, init) =>
      handler({ body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined }),
  };
}

/** Non-streaming chat completion. */
export function completion(content: string, finishReason = "stop"): Response {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** Never answers; rejects once the request is aborted (e.g. by the timeout), like fetch. */
export function hang(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** The user message of a captured request (the report block plus rules). */
export function userText(request: FakeLlmRequest | undefined): string {
  return String(request?.body.messages.find((m) => m.role === "user")?.content ?? "");
}
