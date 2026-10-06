import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { outbriefHome } from "./config.ts";

/**
 * `~/.outbrief/local-api.key`: the bearer of this machine's settings API (127.0.0.1). Only this
 * machine's user can read it (mode 600), so the desktop app on this machine can use it and a web
 * page cannot. It replaces the shared server token the app used to send (YOUT-217).
 */
export function localKeyPath(): string {
  return join(outbriefHome(), "local-api.key");
}

/** The key, created on first use. */
export function loadOrCreateLocalKey(): string {
  const path = localKeyPath();
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Not there yet.
  }
  const key = `obl_${randomBytes(32).toString("base64url")}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}
