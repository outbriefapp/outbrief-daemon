import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type LlmCallLog,
  LlmClient,
  LlmDisabledError,
  LlmFailedError,
  routingOptions,
} from "./client.ts";
import {
  completion,
  type FakeLlmHandler,
  type FakeLlmRequest,
  fakeEndpoint,
  hang,
} from "./testing.ts";

const Answer = z.object({ answer: z.string() });
const ok = completion(JSON.stringify({ answer: "42" }));
const ask = { system: "sys", prompt: "q" };

function setup(handler: FakeLlmHandler, options?: Parameters<typeof fakeEndpoint>[1]) {
  const requests: FakeLlmRequest[] = [];
  const logs: LlmCallLog[] = [];
  const llm = new LlmClient(
    fakeEndpoint((request) => {
      requests.push(request);
      return handler(request);
    }, options),
    { log: (entry) => logs.push(entry) },
  );
  return { llm, requests, logs };
}

async function failure(call: Promise<unknown>): Promise<LlmFailedError> {
  const err = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof LlmFailedError)) throw new Error(`expected LlmFailedError, got ${err}`);
  return err;
}

describe("LlmClient", () => {
  it("returns the structured output and sends reasoning_effort only when set", async () => {
    const plain = setup(() => ok.clone());
    expect(await plain.llm.generateObject("t", Answer, ask)).toEqual({ answer: "42" });
    expect(plain.requests[0]?.body.model).toBe("test-model");
    expect(Object.keys(plain.requests[0]?.body ?? {}).some((k) => k.startsWith("reasoning"))).toBe(
      false,
    );
    expect(plain.logs).toMatchObject([{ task: "t", ok: true }]);

    const tuned = setup(() => ok.clone(), { reasoningEffort: "none" });
    await tuned.llm.generateObject("t", Answer, ask);
    expect(tuned.requests[0]?.body.reasoning_effort).toBe("none");
  });

  it("fails on a 5xx, a timeout, a content filter and a schema mismatch", async () => {
    const down = setup(() => new Response("upstream down", { status: 503 }));
    expect((await failure(down.llm.generateObject("t", Answer, ask))).reason).toBe("error");
    expect(down.logs[0]).toMatchObject({ ok: false, reason: "error" });

    const slow = setup(({ signal }) => hang(signal), { timeoutMs: 50 });
    expect((await failure(slow.llm.generateObject("t", Answer, ask))).reason).toBe("timeout");

    const filtered = setup(() => completion("", "content_filter"));
    expect((await failure(filtered.llm.generateObject("t", Answer, ask))).reason).toBe(
      "content_filter",
    );

    const wrong = setup(() => completion('{"wrong": true}'));
    expect((await failure(wrong.llm.generateObject("t", Answer, ask))).reason).toBe("schema");
  });

  it("asks for json_schema, or for json_object with the schema in the prompt", async () => {
    const strict = setup(() => ok.clone());
    await strict.llm.generateObject("t", Answer, ask);
    expect(strict.requests[0]?.body.response_format).toMatchObject({ type: "json_schema" });

    const loose = setup(() => completion('```json\n{"answer": "42"}\n```'), {
      structuredOutput: "json_object",
    });
    expect(await loose.llm.generateObject("t", Answer, ask)).toEqual({ answer: "42" });
    const body = loose.requests[0]?.body;
    expect(body?.response_format).toEqual({ type: "json_object" });
    const system = String(body?.messages.find((m) => m.role === "system")?.content);
    expect(system).toMatch(/^sys\n\n输出格式/);
    expect(system).toContain('"required":["answer"]');

    const wrong = setup(() => completion('{"nope": 1}'), { structuredOutput: "json_object" });
    expect((await failure(wrong.llm.generateObject("t", Answer, ask))).reason).toBe("schema");
  });

  it("asks OpenRouter to route json_schema only to endpoints that support it", () => {
    expect(routingOptions("https://openrouter.ai/api/v1", "json_schema")).toEqual({
      provider: { require_parameters: true },
    });
    expect(routingOptions("https://openrouter.ai/api/v1", "json_object")).toEqual({});
    expect(routingOptions("https://api.openai.com/v1", "json_schema")).toEqual({});
  });

  it("fails with LlmDisabledError and calls nothing when no endpoint is configured", async () => {
    const llm = new LlmClient(null, { log: () => undefined });
    expect(llm.available).toBe(false);
    await expect(llm.generateObject("t", Answer, ask)).rejects.toBeInstanceOf(LlmDisabledError);
  });

  it("rethrows the caller's abort as is, without logging a failure", async () => {
    const { llm, logs } = setup(({ signal }) => hang(signal));
    const controller = new AbortController();
    const call = llm.generateObject("t", Answer, { ...ask, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const err = await call.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(LlmFailedError);
    expect(logs).toEqual([]);
  });
});
