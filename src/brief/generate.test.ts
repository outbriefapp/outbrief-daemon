import { describe, expect, it } from "vitest";
import { LlmClient } from "../llm/client.ts";
import {
  completion,
  type FakeLlmHandler,
  type FakeLlmRequest,
  fakeEndpoint,
  hang,
  userText,
} from "../llm/testing.ts";
import { type BriefLanguage, systemBriefLanguage } from "./language.ts";
import { ADDRESS_PLACEHOLDER, type Brief, BriefSubmission } from "./schema.ts";
import { generateSubmission } from "./submission.ts";

const FACTS: Brief["facts"] = [
  { id: "f1", text: "登录页重构完成", importance: "critical" },
  { id: "f2", text: "旧的登录接口已删除，属于破坏性变更", importance: "critical" },
  { id: "f3", text: "补了三个单元测试", importance: "normal" },
];

function brief(coveredFactIds: string[], overrides: Partial<Brief> = {}): Brief {
  return {
    verdict: { status: "done", headline: "登录页重构完成" },
    facts: FACTS,
    segments: [
      {
        id: "s1",
        speech: `${ADDRESS_PLACEHOLDER}，登录页重构做完了。`,
        card: { title: "结果", bullets: ["重构完成"] },
        coveredFactIds,
      },
    ],
    decisions: [],
    ...overrides,
  };
}

const FULL_BRIEF = brief(["f1", "f2", "f3"]);

/** What the LLM returns for `b`: the brief plus the 补充说明 title in its language. */
const output = (b: object | undefined, supplementTitle = "补充说明") =>
  JSON.stringify({ ...b, supplementTitle });

function setup(handler: FakeLlmHandler) {
  const requests: FakeLlmRequest[] = [];
  const llm = new LlmClient(
    fakeEndpoint((request) => {
      requests.push(request);
      return handler(request);
    }),
    { log: () => undefined },
  );
  const generate = async (content: string, language: BriefLanguage = "zh-CN") => {
    const submission = await generateSubmission(
      llm,
      { source: "codex", content },
      language,
      () => undefined,
    );
    // Whatever the daemon produces must be what the server accepts.
    expect(BriefSubmission.safeParse(submission).success).toBe(true);
    return submission;
  };
  return { requests, generate };
}

describe("brief generation", () => {
  it("produces a ready brief from one call on primary, addressing the user by placeholder", async () => {
    const { requests, generate } = setup(() => completion(output(FULL_BRIEF)));
    const submission = await generate("登录页重构完成，删了旧接口");
    expect(userText(requests[0])).toContain("登录页重构完成，删了旧接口");
    const system = String(requests[0]?.body.messages.find((m) => m.role === "system")?.content);
    expect(system).toContain(`一律写成 ${ADDRESS_PLACEHOLDER}`);
    expect(submission).toMatchObject({
      status: "ready",
      brief: FULL_BRIEF,
      llmChannel: "primary",
      llmCalls: 1,
      rewritten: false,
      supplemented: false,
      error: null,
    });
  });

  it("fails the brief when the LLM call fails", async () => {
    const { generate } = setup(() => new Response("down", { status: 500 }));
    const submission = await generate("raw report");
    expect(submission).toMatchObject({
      status: "failed",
      brief: null,
      llmChannel: null,
      llmCalls: 1,
      rewritten: false,
      supplemented: false,
    });
    expect(submission.error).toContain("LLM call failed");
  });

  it("fails the brief without any call when no LLM is set", async () => {
    const submission = await generateSubmission(
      new LlmClient(null),
      { source: "codex", content: "report" },
      "zh-CN",
      () => undefined,
    );
    expect(submission).toMatchObject({
      status: "failed",
      brief: null,
      llmChannel: null,
      llmCalls: 0,
      error: "这台电脑没有配置大模型（在 App「设置 → 大模型」里填写）",
    });
  });

  it("rejects instead of failing the brief when the caller aborts", async () => {
    const llm = new LlmClient(
      fakeEndpoint(({ signal }) => hang(signal)),
      { log: () => undefined },
    );
    const controller = new AbortController();
    const pending = generateSubmission(
      llm,
      { source: "codex", content: "report" },
      "zh-CN",
      () => undefined,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it("rewrites once when a critical fact is left unspoken", async () => {
    const replies = [brief(["f1"]), FULL_BRIEF];
    const { requests, generate } = setup(() => completion(output(replies.shift())));
    const submission = await generate("report");
    expect(requests).toHaveLength(2);
    expect(userText(requests[1])).toContain("f2：旧的登录接口已删除");
    expect(submission).toMatchObject({
      brief: FULL_BRIEF,
      llmCalls: 2,
      rewritten: true,
      supplemented: false,
    });
  });

  it("rewrites when speech exceeds 60% of a long report", async () => {
    const long = brief(["f1", "f2"], {
      segments: [
        {
          id: "s1",
          speech: "很".repeat(241),
          card: { title: "t", bullets: [] },
          coveredFactIds: ["f1", "f2"],
        },
      ],
    });
    const replies = [long, FULL_BRIEF];
    const { requests, generate } = setup(() => completion(output(replies.shift())));
    await generate("报告".repeat(200));
    expect(requests).toHaveLength(2);
    expect(userText(requests[1])).toContain("超过上限 240 字");
  });

  it("keeps the first brief when the rewrite fails", async () => {
    let calls = 0;
    const { generate } = setup(() =>
      calls++ === 0 ? completion(output(brief(["f1"]))) : new Response("down", { status: 500 }),
    );
    const submission = await generate("report");
    expect(submission).toMatchObject({
      status: "ready",
      llmCalls: 2,
      rewritten: false,
      supplemented: true,
    });
  });

  it("appends a 补充说明 segment when the rewrite still misses critical facts", async () => {
    const { generate } = setup(() => completion(output(brief(["f1", "ghost"]))));
    const submission = await generate("report");
    const stored = submission.brief;
    expect(stored?.segments.map((s) => s.coveredFactIds)).toEqual([["f1"], ["f2"]]);
    expect(stored?.segments[1]).toMatchObject({
      card: {
        title: "补充说明",
        bullets: ["旧的登录接口已删除，属于破坏性变更"],
      },
    });
    expect(stored?.segments[1]?.speech).toContain("旧的登录接口已删除，属于破坏性变更");
    expect(submission).toMatchObject({ llmCalls: 2, rewritten: true, supplemented: true });
  });

  it("writes the brief in the language set in the app", async () => {
    const { requests, generate } = setup(() => completion(output(FULL_BRIEF)));
    await generate("登录页重构完成", "en-US");
    const system = String(requests[0]?.body.messages.find((m) => m.role === "system")?.content);
    expect(system).toContain("一律用美国英语写");
    expect(system).toContain("美国英语口语");
    expect(system).toContain("不超过 12 个词");
    expect(system).not.toContain("中文口语");
  });

  it("appends the unspoken facts in the brief's language", async () => {
    const facts: Brief["facts"] = [
      { id: "f1", text: "The old login API was removed", importance: "critical" },
    ];
    const { generate } = setup(() => completion(output({ ...brief([]), facts }, "Also note")));
    const submission = await generate("report", "en-US");
    expect(submission.brief?.segments.at(-1)).toMatchObject({
      speech: "Also note: The old login API was removed.",
      card: { title: "Also note" },
    });
  });

  it("opens with the 称呼 when the LLM left it out (OUTB-58)", async () => {
    const segment = {
      ...FULL_BRIEF.segments[0],
      speech: "登录页重构做完了。",
    } as Brief["segments"][number];
    const { generate } = setup(() => completion(output({ ...FULL_BRIEF, segments: [segment] })));
    const zh = await generate("登录页重构完成");
    expect(zh.brief?.segments[0]?.speech).toBe(`${ADDRESS_PLACEHOLDER}，登录页重构做完了。`);
    const { generate: generateEn } = setup(() =>
      completion(output({ ...FULL_BRIEF, segments: [{ ...segment, speech: "It is done." }] })),
    );
    const en = await generateEn("登录页重构完成", "en-US");
    expect(en.brief?.segments[0]?.speech).toBe(`${ADDRESS_PLACEHOLDER}, It is done.`);
  });

  it("reads the 称呼 the LLM wrote with full-width braces or spaces as the placeholder", async () => {
    const speech = "｛称呼｝，登录页重构做完了。{ 称呼 }，要合并吗？";
    const segment = { ...FULL_BRIEF.segments[0], speech } as Brief["segments"][number];
    const { generate } = setup(() => completion(output({ ...FULL_BRIEF, segments: [segment] })));
    const submission = await generate("登录页重构完成");
    expect(submission.brief?.segments[0]?.speech).toBe(
      `${ADDRESS_PLACEHOLDER}，登录页重构做完了。${ADDRESS_PLACEHOLDER}，要合并吗？`,
    );
  });

  it("follows this machine's locale until the app sets a language", () => {
    expect(systemBriefLanguage(["zh-Hans-CN"])).toBe("zh-CN");
    expect(systemBriefLanguage(["zh-Hant"])).toBe("zh-TW");
    expect(systemBriefLanguage(["ja_JP.UTF-8"])).toBe("ja-JP");
    expect(systemBriefLanguage(["pt"])).toBe("pt-BR");
    expect(systemBriefLanguage(["C", "x"])).toBe("en-US");
  });

  it("keeps a recommendation naming an option and nulls invalid, empty or omitted ones", async () => {
    const options = [
      { id: "a", label: "删" },
      { id: "b", label: "留" },
    ];
    const question = { question: "要不要删旧接口？", options };
    const decisions = [
      { id: "d1", ...question, recommendedOptionId: "a", reason: "旧接口没人用了" },
      { id: "d2", ...question, recommendedOptionId: "aToString", reason: "瞎猜的" },
      { id: "d3", ...question, recommendedOptionId: "", reason: "" },
      { id: "d4", ...question },
    ];
    const { requests, generate } = setup(() => completion(output({ ...FULL_BRIEF, decisions })));
    const submission = await generate("report");
    // Gemini garbles nullable strings ("a" -> "aToString"), so they are asked for as plain strings.
    const schema = requests[0]?.body.response_format as {
      json_schema: { schema: { properties: { decisions: { items: { properties: object } } } } };
    };
    expect(schema.json_schema.schema.properties.decisions.items.properties).toMatchObject({
      recommendedOptionId: { type: "string" },
      reason: { type: "string" },
    });
    expect(requests).toHaveLength(1);
    expect(submission.brief?.decisions).toEqual([
      decisions[0],
      ...decisions.slice(1).map((d) => ({ ...d, recommendedOptionId: null, reason: null })),
    ]);
  });
});
