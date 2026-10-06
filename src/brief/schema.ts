/**
 * Brief wire shapes: mirror of outbrief-server protocol.ts, change together. The daemon generates
 * the brief and the server stores it as-is, so both sides must agree on every field.
 */
import { z } from "zod";

/**
 * Where a report came from. `generic` = any HTTP caller; `multica` = a Multica task, reported by the
 * outbrief-daemon that holds the user's Multica token (never POSTed by a hook).
 */
export const AgentSource = z.enum(["claude-code", "codex", "gemini-cli", "generic", "multica"]);
export type AgentSource = z.infer<typeof AgentSource>;

/** Sources a hook may report. */
export const HookSource = AgentSource.exclude(["multica"]);
export type HookSource = z.infer<typeof HookSource>;

export const MAX_REPORT_CHARS = 200_000;

/** Payload a hook POSTs to the daemon's `/report` (the server's `AgentEventInput`). */
export const AgentEventInput = z.object({
  source: HookSource,
  /** Agent-native session id (Claude Code session_id, Codex thread-id) — needed to resume the session later. */
  sessionId: z.string().min(1).max(200).optional(),
  /** Working directory the agent ran in. */
  cwd: z.string().min(1).max(1_000).optional(),
  /** Short human label, usually the project folder name. */
  title: z.string().min(1).max(200).optional(),
  /** The agent's final report, verbatim. */
  content: z.string().trim().min(1).max(MAX_REPORT_CHARS),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});
export type AgentEventInput = z.infer<typeof AgentEventInput>;

// ---------------------------------------------------------------------------------------------
// Brief (P1-4): one structured `generateObject` call per report, then a critical-fact coverage check.
// ---------------------------------------------------------------------------------------------

export const FactImportance = z.enum(["critical", "normal"]);
export type FactImportance = z.infer<typeof FactImportance>;

/** One atomic fact extracted from the report. `critical` facts must be spoken in some segment. */
export const BriefFact = z.object({
  /** Short stable id, e.g. "f1"; referenced by `BriefSegment.coveredFactIds`. */
  id: z.string().min(1),
  text: z.string().min(1),
  importance: FactImportance,
});
export type BriefFact = z.infer<typeof BriefFact>;

/** What the screen shows while the segment is spoken. */
export const BriefCard = z.object({
  title: z.string().min(1),
  bullets: z.array(z.string().min(1)),
});
export type BriefCard = z.infer<typeof BriefCard>;

/** One "page" of the call: a spoken paragraph plus its card. Played in array order. */
export const BriefSegment = z.object({
  /** Short stable id, e.g. "s1". */
  id: z.string().min(1),
  /** Conversational spoken text (assistant voice, conclusion first); split into sentences for TTS. */
  speech: z.string().min(1),
  card: BriefCard,
  coveredFactIds: z.array(z.string()),
});
export type BriefSegment = z.infer<typeof BriefSegment>;

export const DecisionOption = z.object({
  /** Short stable id, e.g. "a". */
  id: z.string().min(1),
  label: z.string().min(1),
});
export type DecisionOption = z.infer<typeof DecisionOption>;

/** A question the agent left for the user. */
export const BriefDecision = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(DecisionOption).min(1),
  recommendedOptionId: z.string().nullable(),
  /** Why the recommended option; null when there is no recommendation. */
  reason: z.string().nullable(),
});
export type BriefDecision = z.infer<typeof BriefDecision>;

/** Overall outcome of the agent's task. */
export const VerdictStatus = z.enum(["done", "partial", "blocked", "failed"]);
export type VerdictStatus = z.infer<typeof VerdictStatus>;

export const Brief = z.object({
  verdict: z.object({ status: VerdictStatus, headline: z.string().min(1) }),
  facts: z.array(BriefFact),
  segments: z.array(BriefSegment).min(1),
  decisions: z.array(BriefDecision),
});
export type Brief = z.infer<typeof Brief>;

/**
 * Which endpoint wrote the brief. There is only the one set in the app (`llm.primary`); the server
 * still accepts "fallback" from daemons that had a hand-set backup endpoint.
 */
export const LlmChannel = z.enum(["primary"]);
export type LlmChannel = z.infer<typeof LlmChannel>;

/**
 * ready  -> `brief` holds the refined brief
 * failed -> generation failed on every channel (or none is configured); `brief` is null and
 *           clients show the raw report
 */
export const BriefStatus = z.enum(["ready", "failed"]);
export type BriefStatus = z.infer<typeof BriefStatus>;

/** The generated brief the daemon attaches to every report it sends (`brief` in the POST body). */
export const BriefSubmission = z
  .object({
    status: BriefStatus,
    /** Non-null iff `status` is "ready". */
    brief: Brief.nullable(),
    /** Null iff `status` is "failed". */
    llmChannel: LlmChannel.nullable(),
    /** 0 when no channel is configured; 2 when a coverage rewrite was requested. */
    llmCalls: z.number().int().min(0).max(2),
    rewritten: z.boolean(),
    supplemented: z.boolean(),
    /** Why generation failed; null when ready. */
    error: z.string().max(1_000).nullable(),
    generatedAt: z.iso.datetime({ offset: true }),
  })
  .refine((s) => (s.status === "ready") === (s.brief !== null), "brief is set iff ready")
  .refine((s) => (s.status === "ready") === (s.llmChannel !== null), "llmChannel is set iff ready")
  .refine((s) => (s.status === "ready") === (s.error === null), "error is set iff failed");
export type BriefSubmission = z.infer<typeof BriefSubmission>;

/**
 * Briefs call the listener by this placeholder instead of a fixed title; each client replaces it
 * with the user's own 称呼 setting before showing or speaking the brief.
 */
export const ADDRESS_PLACEHOLDER = "{称呼}";
