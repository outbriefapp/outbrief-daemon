import type { DaemonConfig } from "../config.ts";
import {
  formatKey,
  generateKey,
  keyFromPassphrase,
  keyId,
  MIN_PASSPHRASE_CHARS,
  openJson,
  parseKey,
  REPORT_AAD,
  replyAad,
  replyErrorAad,
  sealJson,
  sealText,
  settingsAad,
  settingsResultAad,
} from "./crypto.ts";
import type { SealedReply, SealedReport } from "./payloads.ts";
import { SealedReplySchema } from "./payloads.ts";

/** What the app is shown about the key: `GET /e2e/key`. The key itself is only for this machine's app. */
export interface E2eKeyView {
  /** `obk1_…`, for the app on this machine and for copying to another device. */
  key: string;
  keyId: string;
  source: "random" | "passphrase";
  updatedAt: string;
}

/** `PUT /e2e/key` refused it: too short a passphrase, or not an `obk1_…` key. */
export class E2eKeyError extends Error {
  override name = "E2eKeyError";
  readonly code: "passphrase_too_short" | "invalid_key";

  constructor(code: E2eKeyError["code"]) {
    super(code);
    this.code = code;
  }
}

/**
 * This machine's end-to-end key (outbrief-server ADR 0007), kept in `daemon.json` (mode 600). The
 * first start generates a random one; the user may replace it with a passphrase or with a key
 * copied from another device. Reports are sealed with it before they are sent; replies opened.
 */
export class E2eKeyring {
  readonly #config: DaemonConfig;
  readonly #save: (config: DaemonConfig) => void;
  #key: Buffer;

  constructor(
    config: DaemonConfig,
    save: (config: DaemonConfig) => void,
    log: (m: string) => void,
  ) {
    this.#config = config;
    this.#save = save;
    const saved = config.e2e ? parseKey(config.e2e.key) : null;
    if (saved) {
      this.#key = saved;
    } else {
      this.#key = generateKey();
      this.#store("random");
      log(`[e2e] generated a new end-to-end key ${keyId(this.#key)}`);
    }
  }

  view(): E2eKeyView {
    const e2e = this.#config.e2e;
    if (!e2e) throw new Error("e2e key missing from the config");
    return { key: e2e.key, keyId: keyId(this.#key), source: e2e.source, updatedAt: e2e.updatedAt };
  }

  /** Replaces the key. Calls already sealed with the old one can no longer be opened by the apps. */
  set(input: { passphrase?: string; key?: string; random?: boolean }): E2eKeyView {
    if (input.passphrase !== undefined) {
      if ([...input.passphrase.normalize("NFC")].length < MIN_PASSPHRASE_CHARS) {
        throw new E2eKeyError("passphrase_too_short");
      }
      this.#key = keyFromPassphrase(input.passphrase);
      this.#store("passphrase");
    } else if (input.key !== undefined) {
      const key = parseKey(input.key);
      if (!key) throw new E2eKeyError("invalid_key");
      this.#key = key;
      this.#store("random");
    } else if (input.random) {
      this.#key = generateKey();
      this.#store("random");
    } else {
      throw new E2eKeyError("invalid_key");
    }
    return this.view();
  }

  sealReport(report: SealedReport): string {
    return sealJson(this.#key, REPORT_AAD, report);
  }

  /** Throws `SealedOpenError` (wrong key, tampered) or a zod error (not a reply). */
  openReply(eventId: string, sealed: string): SealedReply {
    return SealedReplySchema.parse(openJson(this.#key, replyAad(eventId), sealed));
  }

  sealReplyError(replyId: string, error: string): string {
    return sealText(this.#key, replyErrorAad(replyId), error);
  }

  /** A settings request relayed by the server; throws `SealedOpenError` when it cannot be opened. */
  openSettingsRequest(requestId: string, sealed: string): unknown {
    return openJson(this.#key, settingsAad(requestId), sealed);
  }

  sealSettingsResult(requestId: string, result: unknown): string {
    return sealJson(this.#key, settingsResultAad(requestId), result);
  }

  #store(source: "random" | "passphrase"): void {
    this.#config.e2e = { key: formatKey(this.#key), source, updatedAt: new Date().toISOString() };
    this.#save(this.#config);
  }
}
