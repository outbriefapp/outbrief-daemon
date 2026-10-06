import { describe, expect, it } from "vitest";
import {
  formatKey,
  generateKey,
  keyFromPassphrase,
  keyId,
  openJson,
  openText,
  parseKey,
  REPORT_AAD,
  replyAad,
  SealedOpenError,
  sealJson,
  sealText,
} from "./crypto.ts";

/**
 * Shared with outbrief-app `src/e2e/crypto.test.ts`: both implementations must produce and open
 * exactly these values.
 */
const VECTORS = {
  key: "obk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  keyId: "5d79c9d9b9140ece",
  iv: Buffer.from(Array.from({ length: 12 }, (_, i) => 0xa0 + i)),
  aad: "outbrief:report:v1",
  plaintext: '{"content":"登录页重构完成"}',
  sealed:
    "ob1.5d79c9d9b9140ece.oKGio6Slpqeoqaqr.nTofQiu_Z9EWR73x4ON7O805sLEnXsXhepCiY9Enk4lCVDr-yNLJzPctOtxe0wbxrpaq",
  passphrase: "correct horse battery",
  passphraseKey: "obk1_Lx4pmWArsLrCqKgNPE7sIYbZh5EQ66DRTMvbmmmmsQY",
};

function vectorKey(): Buffer {
  const key = parseKey(VECTORS.key);
  if (!key) throw new Error("vector key does not parse");
  return key;
}

describe("e2e", () => {
  it("matches the shared test vectors", () => {
    const key = vectorKey();
    expect(keyId(key)).toBe(VECTORS.keyId);
    expect(sealText(key, VECTORS.aad, VECTORS.plaintext, VECTORS.iv)).toBe(VECTORS.sealed);
    expect(openText(key, VECTORS.aad, VECTORS.sealed)).toBe(VECTORS.plaintext);
    expect(formatKey(keyFromPassphrase(VECTORS.passphrase))).toBe(VECTORS.passphraseKey);
  });

  it("round-trips JSON with a fresh IV each time", () => {
    const key = generateKey();
    const a = sealJson(key, REPORT_AAD, { content: "done" });
    const b = sealJson(key, REPORT_AAD, { content: "done" });
    expect(a).not.toBe(b);
    expect(openJson(key, REPORT_AAD, a)).toEqual({ content: "done" });
    expect(parseKey(formatKey(key))).toEqual(key);
  });

  it("refuses the wrong key, another purpose, tampering and garbage", () => {
    const key = vectorKey();
    const reason = (run: () => unknown) => {
      try {
        run();
      } catch (err) {
        return err instanceof SealedOpenError ? err.reason : "other";
      }
      return "opened";
    };
    expect(reason(() => openText(generateKey(), VECTORS.aad, VECTORS.sealed))).toBe("wrong_key");
    expect(reason(() => openText(key, replyAad("e1"), VECTORS.sealed))).toBe("tampered");
    const flipped = `${VECTORS.sealed.slice(0, -2)}${VECTORS.sealed.endsWith("aa") ? "ab" : "aa"}`;
    expect(reason(() => openText(key, VECTORS.aad, flipped))).toBe("tampered");
    expect(reason(() => openText(key, VECTORS.aad, "plain text"))).toBe("malformed");
  });

  it("rejects short passphrases and malformed keys", () => {
    expect(() => keyFromPassphrase("short")).toThrow(/at least 12/);
    expect(parseKey("obk1_short")).toBeNull();
    expect(parseKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")).toBeNull();
  });
});
