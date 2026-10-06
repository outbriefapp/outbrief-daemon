/**
 * `outbrief-daemon brief-eval <report files...>`
 *
 * Generates briefs straight from report files with the LLM set in the app (daemon.json `llm`;
 * nothing is sent to the server) and prints the P1-4 quality metrics. Exits 1 when the LLM left a
 * critical fact unspoken or speech exceeds 60 % of a report of at least 300 chars.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { generateBrief, SPEECH_BUDGET_RATIO } from "../brief/generate.ts";
import { systemBriefLanguage } from "../brief/language.ts";
import { configPath, llmEndpoint, loadBriefConfig, loadLlmConfig } from "../config.ts";
import { LlmClient } from "../llm/client.ts";

export async function briefEvalCommand(argv: string[]): Promise<void> {
  const positionals = argv;
  if (!positionals.length) {
    console.error("usage: outbrief-daemon brief-eval <report files...>");
    process.exit(2);
  }
  const endpoint = llmEndpoint(loadLlmConfig());
  if (!endpoint) {
    console.error(`no LLM set (设置 → 大模型 in the app, or llm.primary in ${configPath()})`);
    process.exit(2);
  }
  const llm = new LlmClient(endpoint, { log: () => undefined });
  // The language set in the app (daemon.json `brief`), else this machine's.
  const language = loadBriefConfig()?.language ?? systemBriefLanguage();

  let failed = false;
  for (const file of positionals) {
    const content = (await readFile(file, "utf8")).trim();
    const started = performance.now();
    const result = await generateBrief(
      llm,
      {
        source: "generic",
        title: basename(file),
        content,
      },
      language,
    ).catch((err: unknown) => {
      console.log(`== ${file} FAIL\n${err instanceof Error ? err.message : String(err)}\n`);
    });
    if (!result) {
      failed = true;
      continue;
    }
    const durationMs = Math.round(performance.now() - started);
    const coverage = result.criticalFacts ? result.coveredCriticalFacts / result.criticalFacts : 1;
    const ratio = result.speechChars / result.reportChars;
    const ok = coverage === 1 && (result.speechBudget === null || ratio <= SPEECH_BUDGET_RATIO);
    failed ||= !ok;
    console.log(
      [
        `== ${file} ${ok ? "OK" : "FAIL"} (${language})`,
        `duration: ${durationMs} ms (${result.llmCalls} call${result.llmCalls > 1 ? "s" : ""}${result.rewritten ? ", rewritten" : ""})`,
        `critical facts: ${result.criticalFacts} / facts: ${result.brief.facts.length}`,
        `critical coverage: ${(coverage * 100).toFixed(0)}%${result.supplemented ? " (补充说明 appended)" : ""}`,
        `speech/original: ${result.speechChars}/${result.reportChars} = ${ratio.toFixed(2)}${result.speechBudget === null ? " (short report, no budget)" : ""}`,
        `verdict: ${result.brief.verdict.status} - ${result.brief.verdict.headline}`,
        `decisions: ${result.brief.decisions.length}`,
        "speech:",
        ...result.brief.segments.map((s) => `  [${s.card.title}] ${s.speech}`),
        "",
      ].join("\n"),
    );
  }
  process.exit(failed ? 1 : 0);
}
