import { BriefSettings } from "../brief/settings.ts";
import { generateSubmission } from "../brief/submission.ts";
import { DaemonClient } from "../client.ts";
import {
  llmEndpoint,
  loadConfig,
  multicaApiUrl,
  saveBriefConfig,
  saveConfig,
  saveLlmConfig,
} from "../config.ts";
import { E2eKeyring } from "../e2e/keyring.ts";
import { resumeSession } from "../executor.ts";
import { startListener } from "../listener.ts";
import { LlmSettings } from "../llm/settings.ts";
import { loadOrCreateLocalKey } from "../localKey.ts";
import { Dispatcher, DispatchStore } from "../multica/dispatch.ts";
import { MulticaService } from "../multica/service.ts";
import { Outbox } from "../outbox.ts";
import { createPairingCode, pairingLink } from "../pairing.ts";
import { createReplyHandler } from "../replies.ts";
import { createSettingsApi } from "../settingsApi.ts";
import { StateStore } from "../state.ts";

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

export async function runCommand(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    process.stderr.write("Not paired — run: outbrief-daemon login\n");
    process.exit(1);
  }

  const state = new StateStore();
  // End-to-end key: reports leave this machine sealed, replies arrive sealed (ADR 0007).
  const keyring = new E2eKeyring(config, saveConfig, log);
  log(`E2E: key ${keyring.view().keyId} (${keyring.view().source})`);

  // Briefs are generated here with this machine's own LLM keys; the server only stores them.
  const endpoint = llmEndpoint(config.llm);
  log(
    endpoint
      ? `LLM: ${endpoint.model} @ ${endpoint.baseUrl}`
      : "LLM: not set yet (设置 → 大模型 in the app) — reports are sent with a failed brief (raw report only)",
  );
  // The app replaces the endpoint through the settings API; the next brief uses it.
  const llm = new LlmSettings({
    llm: config.llm,
    save: saveLlmConfig,
    client: { log: (entry) => log(`[llm] ${JSON.stringify(entry)}`) },
    log,
  });
  // The app sets the language (设置 → 语音 → 汇报语言); the next brief uses it.
  const brief = new BriefSettings({ brief: config.brief, save: saveBriefConfig, log });
  const { language, source } = brief.view();
  log(
    `Brief language: ${language} (${source === "app" ? "set in the app" : "this machine's language"})`,
  );
  const outbox = new Outbox({
    serverUrl: config.serverUrl,
    token: config.token,
    generate: (report, signal) =>
      generateSubmission(llm.client, report, brief.language, log, signal),
    seal: (report) => keyring.sealReport(report),
    log,
  });
  outbox.start();

  // The user's Multica token lives only here; the server just receives the reports.
  const multica = new MulticaService({
    config,
    save: saveConfig,
    apiUrl: multicaApiUrl(),
    log,
    enqueueReport: (report) => outbox.add({ kind: "multica", input: report }) !== null,
  });
  multica.start();

  // 主动派单: the app asks Multica's smart create to turn what the user said into an issue.
  const dispatcher = new Dispatcher({
    client: (workspaceId) => multica.client(workspaceId),
    store: new DispatchStore(),
  });

  const settingsApi = createSettingsApi({
    multica,
    dispatcher,
    e2e: keyring,
    llm,
    brief,
    localKey: loadOrCreateLocalKey(),
    // The desktop app on this machine joins this machine's account with it, key included.
    pairing: async () => {
      const code = await createPairingCode(config.serverUrl, config.token);
      const key = keyring.view().key;
      return {
        ...code,
        serverUrl: config.serverUrl,
        key,
        link: pairingLink({ serverUrl: config.serverUrl, code: code.code, key }),
      };
    },
    port: config.localPort,
    log,
  });
  const listener = startListener(config, state, outbox, log, settingsApi.handle);
  log(`Listener started on port ${listener.port}`);

  /** Reports the outcome; a failure reason is sealed so the server cannot read it either. */
  const settle = (
    replyId: string,
    status: "delivered" | "failed",
    error?: string,
    commentId?: string,
  ) =>
    client.sendResult(
      replyId,
      status,
      error ? keyring.sealReplyError(replyId, error) : undefined,
      commentId,
    );

  const handleReply = createReplyHandler({
    state,
    open: (eventId, sealed) => keyring.openReply(eventId, sealed),
    postToMultica: (target, content) => multica.postReply(target, content),
    resume: (agent, sessionId, cwd, content) =>
      resumeSession(agent, sessionId, cwd, content, config),
    settle,
    failPlain: (replyId, error) => client.sendResult(replyId, "failed", error),
    log,
  });

  const client = new DaemonClient(
    config,
    (reply) => {
      void handleReply(reply);
    },
    settingsApi.relay,
  );

  client.start();
  log("DaemonClient started");

  // Graceful shutdown.
  const shutdown = (): void => {
    log("Shutting down…");
    client.stop();
    listener.close();
    // Reports still generating or posting stay in the outbox and resume on the next start.
    void Promise.allSettled([multica.stop(), outbox.close()]).finally(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive.
  await new Promise<never>(() => {
    /* runs until signal */
  });
}
