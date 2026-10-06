import { describe, expect, it } from "vitest";
import type { DaemonConfig } from "../config.ts";
import {
  openJson,
  openText,
  parseKey,
  REPORT_AAD,
  replyAad,
  replyErrorAad,
  SealedOpenError,
  sealJson,
} from "./crypto.ts";
import { E2eKeyring } from "./keyring.ts";

function keyring(config = {} as DaemonConfig) {
  const saves: DaemonConfig[] = [];
  const logs: string[] = [];
  const ring = new E2eKeyring(
    config,
    (c) => saves.push(structuredClone(c)),
    (m) => logs.push(m),
  );
  return { ring, config, saves, logs };
}

describe("E2eKeyring", () => {
  it("generates and saves a random key on first start, then keeps it", () => {
    const { ring, config, saves, logs } = keyring();
    expect(saves).toHaveLength(1);
    expect(config.e2e).toMatchObject({ source: "random" });
    expect(logs[0]).toMatch(/generated a new end-to-end key/);
    const again = keyring(config);
    expect(again.saves).toHaveLength(0);
    expect(again.ring.view().keyId).toBe(ring.view().keyId);
  });

  it("seals reports and failure reasons, and opens replies, with the same key the app holds", () => {
    const { ring, config } = keyring();
    const key = parseKey(config.e2e?.key ?? "");
    if (!key) throw new Error("no key");
    const report = {
      content: "done",
      brief: {
        status: "failed" as const,
        brief: null,
        llmChannel: null,
        error: "x",
        generatedAt: "t",
      },
    };
    expect(openJson(key, REPORT_AAD, ring.sealReport(report))).toEqual(report);
    expect(openText(key, replyErrorAad("r1"), ring.sealReplyError("r1", "boom"))).toBe("boom");

    const reply = { content: "继续", sessionId: "s1", multica: null };
    expect(ring.openReply("e1", sealJson(key, replyAad("e1"), reply))).toEqual(reply);
    // A reply sealed for another event is refused.
    expect(() => ring.openReply("e2", sealJson(key, replyAad("e1"), reply))).toThrow(
      SealedOpenError,
    );
  });

  it("refuses a reply sealed with another key", () => {
    const { ring } = keyring();
    const other = keyring().ring;
    const otherKey = parseKey(other.view().key);
    if (!otherKey) throw new Error("no key");
    const sealed = sealJson(otherKey, replyAad("e1"), {
      content: "x",
      sessionId: null,
      multica: null,
    });
    expect(() => ring.openReply("e1", sealed)).toThrow(/sealed with key/);
  });
});
