import { describe, expect, it } from "vitest";
import type { LlmChannelConfig, LlmConfig } from "../config.ts";
import { keyHint, LlmSettings, LlmSettingsError } from "./settings.ts";

function settings(llm: LlmConfig | undefined) {
  const writes: (LlmChannelConfig | null)[] = [];
  const service = new LlmSettings({
    llm,
    save: (channel) => {
      writes.push(channel);
      return channel ? { primary: channel } : undefined;
    },
    client: { log: () => undefined },
    log: () => undefined,
  });
  return { service, writes };
}

describe("LlmSettings", () => {
  it("shows the key hint only", () => {
    const { service } = settings({
      primary: { baseUrl: "https://gw.test/v1", apiKey: "primary-secret-key", model: "g" },
    });
    expect(service.view()).toEqual({
      channel: {
        baseUrl: "https://gw.test/v1",
        model: "g",
        keyHint: "pri…-key",
        structuredOutput: "json_schema",
      },
    });
    expect(keyHint("short")).toBe("…");
  });

  it("saves the endpoint and rebuilds the client for the next brief", () => {
    const { service, writes } = settings(undefined);
    expect(service.client.available).toBe(false);
    const before = service.client;
    const view = service.save({
      baseUrl: " https://api.deepseek.com/v1 ",
      apiKey: " sk-1234567890 ",
      model: " deepseek-chat ",
      structuredOutput: "json_object",
    });
    expect(writes).toEqual([
      {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-1234567890",
        model: "deepseek-chat",
        structuredOutput: "json_object",
      },
    ]);
    expect(view.channel).toEqual({
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      keyHint: "sk-…7890",
      structuredOutput: "json_object",
    });
    expect(service.client).not.toBe(before);
    expect(service.client.available).toBe(true);
  });

  it("keeps the saved key when none is sent, and hand-tuned options only for the same model", () => {
    const primary = {
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "sk-primary-key",
      model: "gemini-3.8-flash-high(low)",
      reasoningEffort: "none",
      timeoutMs: 20_000,
    };
    const { service, writes } = settings({ primary });
    service.save({ baseUrl: primary.baseUrl, model: primary.model });
    expect(writes.at(-1)).toEqual({ ...primary, structuredOutput: "json_schema" });
    service.save({ baseUrl: primary.baseUrl, model: "other-model" });
    expect(writes.at(-1)).toEqual({
      baseUrl: primary.baseUrl,
      apiKey: "sk-primary-key",
      model: "other-model",
      structuredOutput: "json_schema",
    });
  });

  it("rejects a malformed endpoint and a missing key", () => {
    const { service, writes } = settings(undefined);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err instanceof LlmSettingsError ? err.code : String(err);
      }
      return "no error";
    };
    expect(code(() => service.save({ baseUrl: "api.test", apiKey: "k", model: "m" }))).toBe(
      "invalid_llm_settings",
    );
    expect(
      code(() => service.save({ baseUrl: "https://a.test/v1", apiKey: "k", model: " " })),
    ).toBe("invalid_llm_settings");
    expect(code(() => service.save({ baseUrl: "https://a.test/v1", model: "m" }))).toBe(
      "llm_key_required",
    );
    expect(
      code(() =>
        service.save({
          baseUrl: "https://a.test/v1",
          apiKey: "k",
          model: "m",
          structuredOutput: "yaml" as never,
        }),
      ),
    ).toBe("invalid_llm_settings");
    expect(writes).toEqual([]);
  });

  it("removes the endpoint", () => {
    const { service } = settings({
      primary: { baseUrl: "https://a.test/v1", apiKey: "sk-primary-key", model: "m" },
    });
    expect(service.remove()).toEqual({ channel: null });
    expect(service.client.available).toBe(false);
  });
});
