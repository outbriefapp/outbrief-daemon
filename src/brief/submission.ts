import { type LlmClient, LlmDisabledError } from "../llm/client.ts";
import type { ReportText } from "../llm/reportText.ts";
import { generateBrief } from "./generate.ts";
import type { BriefLanguage } from "./language.ts";
import type { BriefSubmission } from "./schema.ts";

/** `BriefSubmission.error` limit on the server. */
const MAX_ERROR_CHARS = 1_000;

/**
 * Generates the brief a report is sent with. A failed LLM call (or none configured)
 * yields a "failed" submission, the product's degraded mode: clients read the raw report. Only a
 * caller abort (daemon shutting down) rejects, so the report is retried on the next start.
 */
export async function generateSubmission(
  llm: LlmClient,
  report: ReportText,
  language: BriefLanguage,
  log: (message: string) => void,
  signal?: AbortSignal,
): Promise<BriefSubmission> {
  try {
    const result = await generateBrief(llm, report, language, signal);
    const { brief, llmCalls, rewritten, supplemented, ...metrics } = result;
    log(
      `[brief] ready ${JSON.stringify({ language, llmCalls, rewritten, supplemented, ...metrics })}`,
    );
    return {
      status: "ready",
      brief,
      llmChannel: "primary",
      llmCalls: llmCalls === 2 ? 2 : 1,
      rewritten,
      supplemented,
      error: null,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    const error = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
    log(`[brief] failed: ${error}`);
    return {
      status: "failed",
      brief: null,
      llmChannel: null,
      llmCalls: err instanceof LlmDisabledError ? 0 : 1,
      rewritten: false,
      supplemented: false,
      error,
      generatedAt: new Date().toISOString(),
    };
  }
}
