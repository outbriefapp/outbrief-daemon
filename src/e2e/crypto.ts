import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * End-to-end encryption between this daemon and the user's apps (outbrief-server ADR 0007). The
 * server relays sealed text and never holds the key. outbrief-app `src/e2e/crypto.ts` implements
 * the same format with WebCrypto; both test suites check the same vectors.
 *
 * - Key: 32 random bytes, or PBKDF2-HMAC-SHA256(passphrase, `KDF_SALT`, `KDF_ITERATIONS`).
 *   Written as `obk1_<base64url>` so it can be copied to another device.
 * - Sealed text: `ob1.<keyId>.<iv>.<ciphertext>`: AES-256-GCM, a fresh 12-byte IV each time, the
 *   16-byte tag appended to the ciphertext, and an AAD naming what the text is (a report cannot be
 *   replayed as a reply). `keyId` = first 8 bytes of SHA-256("outbrief-key-id" ‖ key), in hex.
 */

export const KEY_PREFIX = "obk1_";
export const SEALED_PREFIX = "ob1";
export const KDF_SALT = "outbrief-e2e-v1";
export const KDF_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_CHARS = 12;

/** AAD of a report (with its brief), sealed here and opened by the apps. */
export const REPORT_AAD = "outbrief:report:v1";
/** AAD of the user's reply to one event, sealed by an app and opened here. */
export function replyAad(eventId: string): string {
  return `outbrief:reply:v1:${eventId}`;
}
/** AAD of the reason a reply failed, sealed here and opened by the apps. */
export function replyErrorAad(replyId: string): string {
  return `outbrief:reply-error:v1:${replyId}`;
}

/**
 * AAD of a settings request an app sent through the server (a phone has no local daemon to ask);
 * `requestId` is the app's UUID for that request. The answer uses `settingsResultAad`.
 */
export function settingsAad(requestId: string): string {
  return `outbrief:settings:v1:${requestId}`;
}
export function settingsResultAad(requestId: string): string {
  return `outbrief:settings-result:v1:${requestId}`;
}

/** The sealed text could not be opened; `reason` says whether the key or the text is at fault. */
export class SealedOpenError extends Error {
  override name = "SealedOpenError";
  readonly reason: "wrong_key" | "malformed" | "tampered";

  constructor(reason: SealedOpenError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

export function generateKey(): Buffer {
  return randomBytes(32);
}

/** The same passphrase gives the same key on every device. Throws when it is too short. */
export function keyFromPassphrase(passphrase: string): Buffer {
  const normalized = passphrase.normalize("NFC");
  if ([...normalized].length < MIN_PASSPHRASE_CHARS) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters`);
  }
  return pbkdf2Sync(normalized, KDF_SALT, KDF_ITERATIONS, 32, "sha256");
}

export function formatKey(key: Buffer): string {
  return `${KEY_PREFIX}${key.toString("base64url")}`;
}

/** Parses `obk1_…`; null when it is not a 32-byte key. */
export function parseKey(text: string): Buffer | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(KEY_PREFIX)) return null;
  const encoded = trimmed.slice(KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64url");
  return key.length === 32 ? key : null;
}

export function keyId(key: Buffer): string {
  return createHash("sha256")
    .update("outbrief-key-id")
    .update(key)
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

/** Encrypts `plaintext`; `iv` is a test seam (never pass one in production). */
export function sealText(
  key: Buffer,
  aad: string,
  plaintext: string,
  iv = randomBytes(12),
): string {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return [SEALED_PREFIX, keyId(key), iv.toString("base64url"), body.toString("base64url")].join(
    ".",
  );
}

export function openText(key: Buffer, aad: string, sealed: string): string {
  const parts = sealed.split(".");
  const [version, id, ivText, bodyText] = parts;
  if (parts.length !== 4 || version !== SEALED_PREFIX || !id || !ivText || !bodyText) {
    throw new SealedOpenError("malformed", "not sealed text");
  }
  if (id !== keyId(key)) {
    throw new SealedOpenError(
      "wrong_key",
      `sealed with key ${id}, this machine has key ${keyId(key)}`,
    );
  }
  const iv = Buffer.from(ivText, "base64url");
  const body = Buffer.from(bodyText, "base64url");
  if (iv.length !== 12 || body.length < 16)
    throw new SealedOpenError("malformed", "not sealed text");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(body.subarray(body.length - 16));
  try {
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SealedOpenError("tampered", "sealed text failed authentication");
  }
}

export function sealJson(key: Buffer, aad: string, value: unknown): string {
  return sealText(key, aad, JSON.stringify(value));
}

export function openJson(key: Buffer, aad: string, sealed: string): unknown {
  const text = openText(key, aad, sealed);
  try {
    return JSON.parse(text);
  } catch {
    throw new SealedOpenError("malformed", "sealed payload is not JSON");
  }
}
