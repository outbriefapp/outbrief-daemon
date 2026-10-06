/**
 * What goes inside sealed text: mirror of outbrief-server protocol.ts (`SealedReport`,
 * `SealedReply`) and outbrief-app `src/protocol.ts`, change together. The server cannot read or
 * validate these; the daemon and the apps must agree on every field.
 */
import { z } from "zod";
import type { Brief, BriefStatus, LlmChannel } from "../brief/schema.ts";

/** The brief as the apps read it. */
export interface BriefEnvelope {
  status: BriefStatus;
  brief: Brief | null;
  llmChannel: LlmChannel | null;
  /** Why generation failed; null when ready. */
  error: string | null;
  generatedAt: string;
}

/** Where a `multica` report came from, and where its reply is posted. */
export interface MulticaOrigin {
  workspaceId: string;
  /** Absent on reports from daemons that listened to one workspace only. */
  workspaceName?: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  projectId: string | null;
  projectTitle: string | null;
  /** When the task finished; the app refreshes both from Multica for its call list. */
  issuePriority: string;
  issueUpdatedAt: string;
  agentId: string;
  agentName: string;
  reportCommentId: string;
}

/** Plaintext of a report's `sealed`. AAD: `outbrief:report:v1`. */
export interface SealedReport {
  title?: string;
  content: string;
  cwd?: string;
  sessionId?: string;
  brief: BriefEnvelope;
  multica?: MulticaOrigin;
}

/** Plaintext of a reply's `sealed`, written by an app. AAD: `outbrief:reply:v1:<eventId>`. */
export const SealedReplySchema = z.object({
  content: z.string().trim().min(1),
  sessionId: z.string().nullable(),
  multica: z
    .object({ workspaceId: z.string(), issueId: z.string(), reportCommentId: z.string() })
    .nullable(),
});
export type SealedReply = z.infer<typeof SealedReplySchema>;
