import type { AgentSource } from "../brief/schema.ts";

/** Report characters sent to the LLM; longer reports keep the head and the (usually conclusive) tail. */
export const REPORT_INPUT_MAX_CHARS = 60_000;
const HEAD_CHARS = 20_000;

export interface ReportText {
  source: AgentSource;
  title?: string;
  cwd?: string;
  content: string;
}

/** The report as a prompt block: metadata plus the verbatim (possibly truncated) content. */
export function reportBlock({ source, title, cwd, content }: ReportText): string {
  const lines = [`来源 Agent：${source}`];
  if (title) lines.push(`项目：${title}`);
  if (cwd) lines.push(`工作目录：${cwd}`);
  lines.push(`汇报原文（共 ${content.length} 字）：`);
  if (content.length <= REPORT_INPUT_MAX_CHARS) {
    lines.push("<report>", content, "</report>");
    return lines.join("\n");
  }
  const tailChars = REPORT_INPUT_MAX_CHARS - HEAD_CHARS;
  const omitted = content.length - REPORT_INPUT_MAX_CHARS;
  lines.push(
    `（原文太长，只保留开头 ${HEAD_CHARS} 字和结尾 ${tailChars} 字，中间省略约 ${omitted} 字；` +
      "被省略的部分不要猜测，需要时告诉用户可以看原文。）",
    "<report>",
    content.slice(0, HEAD_CHARS),
    `[……中间省略约 ${omitted} 字……]`,
    content.slice(-tailChars),
    "</report>",
  );
  return lines.join("\n");
}
