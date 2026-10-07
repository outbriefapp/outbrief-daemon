import { z } from "zod";
import type { LlmClient } from "../llm/client.ts";
import { type ReportText, reportBlock } from "../llm/reportText.ts";
import { type BriefLanguage, briefLanguageName, countsCharacters } from "./language.ts";
import {
  ADDRESS_PLACEHOLDER,
  Brief,
  BriefDecision,
  type BriefFact,
  type BriefSegment,
} from "./schema.ts";

/** Reports shorter than this are just "kept concise" instead of held to the speech budget. */
export const SHORT_REPORT_CHARS = 300;
/** Total spoken characters allowed, as a share of the original report (P1-4). */
export const SPEECH_BUDGET_RATIO = 0.6;

/** "20 个字" in CJK languages, "12 个词" in the others. */
function lengthLimit(language: BriefLanguage, chars: number, words: number): string {
  return countsCharacters(language) ? `${chars} 个字` : `${words} 个词`;
}

/** How speech length is counted: `speech.length`, i.e. characters. */
function charUnit(language: BriefLanguage): string {
  return countsCharacters(language) ? "字" : "个字符";
}

function systemPrompt(language: BriefLanguage): string {
  const name = briefLanguageName(language);
  return `你是用户的私人助理。用户同时指挥好几个 AI 编程 Agent（Claude Code、Codex 等），Agent 干完活会写一份书面汇报。你的任务：读完汇报，像一位能干的真人助理在电话里向用户口头汇报那样，把它讲清楚。用户正在忙别的，主要靠耳朵听，偶尔瞄一眼屏幕上的卡片。

称呼：第一段 speech 必须以 ${ADDRESS_PLACEHOLDER} 开头，像打电话先叫人一样（例如“${ADDRESS_PLACEHOLDER}，……”）；之后需要称呼用户时也一律写成 ${ADDRESS_PLACEHOLDER}（连同半角大括号原样写出），客户端会替换成用户自己设置的称呼；不要写“老板”之类的固定称呼，也不要写用户的名字。开头之外只在提问时用，不必每段都用。

语言：简报里给用户看和听的文字（headline、facts 的 text、speech、card、decisions 的 question、options 的 label、reason）一律用${name}写，不管汇报原文是什么语言；专有名词、文件名、命令可以保留原文。

输出一个符合 schema 的 JSON 对象，字段要求如下。

verdict
- status：done = 任务完成；partial = 只完成了一部分；blocked = 卡住了，要用户介入才能继续；failed = 失败。
- headline：一句话结论，不超过 ${lengthLimit(language, 20, 12)}。

facts：把汇报拆成原子事实，每条一句话，id 依次用 f1、f2、f3……
- critical：任务结果（做完没有、效果如何）；失败、报错、测试没过；风险和隐患；破坏性变更（接口、数据、配置不兼容，删掉了东西）；需要用户亲自处理的事；需要用户拍板的决定。
- 其余都是 normal。
- 只写汇报里有的内容，不要推测、不要编造。

segments：口播段落，按播放顺序排列，id 依次用 s1、s2……
- 结论先行：第一段直接说做完没有、结果怎么样、有没有要用户处理的事；然后再讲细节，重要的在前。
- speech 是打电话时说的话：${name}口语，短句，自然连贯，像人在说话，不要念稿腔。汇报是别的语言也用${name}讲，专有名词可以保留原文。
- speech 里不要出现 markdown、列表符号、表格、代码、emoji。
- 文件路径、命令、代码、URL、哈希、长标识符不要逐字念出来，换成自然说法，比如“登录页的组件”“跑了一遍测试”；确实需要时只说文件名或关键词。
- 数字按${name}的口语习惯说，比如中文说“两百多个测试”“快一倍”“百分之九十五”；准确的数字如果是重点就照实说。
- card 是这段话播放时屏幕上显示的卡片：title 不超过 ${lengthLimit(language, 12, 6)}；bullets 2 到 5 条短句，可以保留文件名、命令、数字等书面信息。
- coveredFactIds 列出这段 speech 真正讲到的事实 id。每个 critical 事实都必须在某一段的 speech 里讲到，并在该段 coveredFactIds 里标出；不要标没讲到的事实。

decisions：Agent 在汇报里留给用户的待决问题（选方案、确认要不要继续、要不要合并等）。没有就返回空数组。
- options 列出可选项，id 依次用 a、b、c……，label 简短。
- recommendedOptionId：Agent 推荐的选项，或者你根据汇报内容有把握推荐的选项，只填该选项的 id 本身（例如 a）；没有依据就填空字符串。reason：一句话推荐理由，没有推荐时填空字符串。
- 每个待决问题同时也是一条 critical 事实，要在口播里讲到，一般放在最后一段，问用户怎么定。

supplementTitle：“补充说明”这个标题的${name}说法（两三个词），用于客户端在末尾补读遗漏的事实。

长度：在讲清所有 critical 事实的前提下越短越好，normal 事实可以一笔带过或者不讲。`;
}

/**
 * What the LLM returns: `Brief`, except that a decision's `recommendedOptionId` / `reason` are
 * plain strings, "" meaning none. Gemini's constrained decoding mangles nullable strings (a
 * recommendation "a" comes back as "aToString" or "a-keep-v1…", `reason` goes missing), which
 * nulled real recommendations; a missing field still reads as "". `supplementTitle` is "补充说明" in
 * the brief's language, for the segment of unspoken critical facts; it is not part of the brief.
 */
const BriefOutput = Brief.extend({
  supplementTitle: z.string().trim().min(1),
  decisions: z.array(
    BriefDecision.extend({
      recommendedOptionId: z.string().catch(""),
      reason: z.string().catch(""),
    }),
  ),
});
type BriefOutput = z.infer<typeof BriefOutput>;

export interface BriefResult {
  brief: Brief;
  /** 1, or 2 when a rewrite was requested. */
  llmCalls: number;
  rewritten: boolean;
  supplemented: boolean;
  criticalFacts: number;
  /** Critical facts the LLM output itself covered (the 补充说明 segment does not count). */
  coveredCriticalFacts: number;
  speechChars: number;
  reportChars: number;
  /** Spoken-character limit; null for short reports. */
  speechBudget: number | null;
}

interface Inspection {
  brief: Brief;
  supplementTitle: string;
  missing: BriefFact[];
  critical: number;
  speechChars: number;
}

/**
 * Normalizes LLM output against its own references: duplicate fact ids keep the first,
 * `coveredFactIds` keep only real facts, and a recommendation must name one of its options
 * (else it and its reason become null).
 */
function inspect(raw: BriefOutput): Inspection {
  const facts = raw.facts.filter((f, i) => raw.facts.findIndex((g) => g.id === f.id) === i);
  const factIds = new Set(facts.map((f) => f.id));
  const segments = raw.segments.map((s) => ({
    ...s,
    coveredFactIds: [...new Set(s.coveredFactIds)].filter((id) => factIds.has(id)),
  }));
  const decisions = raw.decisions.map((d) => {
    const recommended = d.options.some((o) => o.id === d.recommendedOptionId);
    return {
      ...d,
      recommendedOptionId: recommended ? d.recommendedOptionId : null,
      reason: recommended && d.reason ? d.reason : null,
    };
  });
  const covered = new Set(segments.flatMap((s) => s.coveredFactIds));
  const critical = facts.filter((f) => f.importance === "critical");
  const { supplementTitle, ...brief } = raw;
  return {
    brief: { ...brief, facts, segments, decisions },
    supplementTitle,
    missing: critical.filter((f) => !covered.has(f.id)),
    critical: critical.length,
    speechChars: segments.reduce((n, s) => n + s.speech.length, 0),
  };
}

function rewritePrompt(
  report: string,
  previous: Inspection,
  rule: string,
  budget: number | null,
  language: BriefLanguage,
): string {
  const problems = previous.missing.length
    ? [
        "这些 critical 事实没有在任何一段 speech 里讲到（或没有标进 coveredFactIds），必须讲进口播并标注：",
        ...previous.missing.map((f) => `- ${f.id}：${f.text}`),
      ]
    : [];
  if (budget !== null && previous.speechChars > budget) {
    const unit = charUnit(language);
    problems.push(
      `speech 总共 ${previous.speechChars} ${unit}，超过上限 ${budget} ${unit}，必须压缩。`,
    );
  }
  return [
    report,
    rule,
    "你上一版的简报如下：",
    "<previous_brief>",
    JSON.stringify(previous.brief),
    "</previous_brief>",
    "它有以下问题：",
    ...problems,
    "请输出修正后的完整简报（其余要求不变，事实 id 保持不变）。",
  ].join("\n");
}

/** Chinese and Japanese take full-width punctuation and no spaces. */
function takesFullWidth(language: BriefLanguage): boolean {
  return ["zh", "ja"].includes(language.split("-")[0] ?? "");
}

/** `{称呼}` as models also write it: full-width braces, spaces inside. */
const PLACEHOLDER_VARIANT = /[{｛]\s*称呼\s*[}｝]/g;

/**
 * `brief` that opens by addressing the user as the prompt asks: some models (e.g. DeepSeek) leave
 * `{称呼}` out or write it their own way, and then the call never says the 称呼 set in the app
 * (OUTB-58).
 */
export function addressUser(brief: Brief, language: BriefLanguage): Brief {
  const json = JSON.stringify(brief);
  const normalized = json.replace(PLACEHOLDER_VARIANT, ADDRESS_PLACEHOLDER);
  const fixed: Brief = normalized === json ? brief : JSON.parse(normalized);
  const [first, ...rest] = fixed.segments;
  if (!first || first.speech.trimStart().startsWith(ADDRESS_PLACEHOLDER)) return fixed;
  const comma = takesFullWidth(language) ? "，" : ", ";
  return {
    ...fixed,
    segments: [{ ...first, speech: `${ADDRESS_PLACEHOLDER}${comma}${first.speech}` }, ...rest],
  };
}

/** Critical facts the LLM would not speak, read out verbatim at the end of the call. */
function supplementSegment(
  missing: BriefFact[],
  index: number,
  title: string,
  language: BriefLanguage,
): BriefSegment {
  const fullWidth = takesFullWidth(language);
  const stop = fullWidth ? "。" : ".";
  const sentences = missing.map((f) => (/[。！？.!?]$/.test(f.text) ? f.text : `${f.text}${stop}`));
  return {
    id: `supplement-${index}`,
    speech: fullWidth ? `${title}：${sentences.join("")}` : `${title}: ${sentences.join(" ")}`,
    card: { title, bullets: missing.map((f) => f.text) },
    coveredFactIds: missing.map((f) => f.id),
  };
}

/**
 * One structured call, then the coverage check (P1-4): every critical fact must be spoken and
 * (for reports of at least 300 chars) speech must fit 60 % of the report. Otherwise one rewrite
 * call; facts still unspoken get a trailing "补充说明" segment. Everything the user sees or hears is
 * written in `language`. Throws when the first call fails; a failed rewrite keeps the first brief.
 */
export async function generateBrief(
  llm: LlmClient,
  report: ReportText,
  language: BriefLanguage,
  signal?: AbortSignal,
): Promise<BriefResult> {
  const reportChars = report.content.length;
  const budget =
    reportChars < SHORT_REPORT_CHARS ? null : Math.floor(reportChars * SPEECH_BUDGET_RATIO);
  const block = reportBlock(report);
  const unit = charUnit(language);
  const rule =
    budget === null
      ? `原汇报只有 ${reportChars} ${unit}，口播简洁即可，一两段就够。`
      : `所有 speech 加起来不能超过 ${budget} ${unit}（原汇报 ${reportChars} ${unit}的 60%），越短越好。`;
  const system = systemPrompt(language);
  const first = await llm.generateObject("brief", BriefOutput, {
    system,
    prompt: `${block}\n${rule}`,
    signal,
  });
  let result = inspect(first);
  let llmCalls = 1;
  let rewritten = false;
  if (result.missing.length || (budget !== null && result.speechChars > budget)) {
    llmCalls = 2;
    try {
      const second = await llm.generateObject("brief-rewrite", BriefOutput, {
        system,
        prompt: rewritePrompt(block, result, rule, budget, language),
        signal,
      });
      result = inspect(second);
      rewritten = true;
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  const { missing, critical, speechChars } = result;
  const addressed = addressUser(result.brief, language);
  const brief = missing.length
    ? {
        ...addressed,
        segments: [
          ...addressed.segments,
          supplementSegment(
            missing,
            addressed.segments.length + 1,
            result.supplementTitle,
            language,
          ),
        ],
      }
    : addressed;
  return {
    brief,
    llmCalls,
    rewritten,
    supplemented: missing.length > 0,
    criticalFacts: critical,
    coveredCriticalFacts: critical - missing.length,
    speechChars,
    reportChars,
    speechBudget: budget,
  };
}
