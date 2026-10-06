import { hostname } from "node:os";

/**
 * Accounts and pairing on the server (outbrief-server ADR 0008). There is no login: the first
 * device creates an anonymous account, the others join it with a one-time 6-digit code. Mirrors
 * the shapes of outbrief-server `src/protocol.ts`.
 */

export type DeviceKind = "daemon" | "app";
export type SignupMode = "open" | "claim" | "closed";

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  online: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  current: boolean;
}

/** `POST /v1/accounts`, `POST /v1/pairing/redeem`. */
export interface DeviceSession {
  accountId: string;
  device: Device;
  token: string;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

export interface PairingCodeStatus extends PairingCode {
  usedAt: string | null;
  usedBy: { id: string; name: string; kind: DeviceKind } | null;
}

/** `POST /local/pairing`: what the desktop app on this machine joins this machine's account with. */
export interface LocalPairing extends PairingCode {
  serverUrl: string;
  /** This machine's end-to-end key (`obk1_…`). */
  key: string;
  link: string;
}

/** A server call failed; `code` is the body's `error` (e.g. `invalid_pairing_code`). */
export class ServerApiError extends Error {
  override name = "ServerApiError";
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(
  serverUrl: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const res = await fetch(new URL(path, serverUrl), {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return (await res.json()) as T;
  const text = await res.text().catch(() => "");
  let code: string | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    code = typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    // not JSON
  }
  throw new ServerApiError(res.status, code, `${path} → ${res.status} ${text}`.trim());
}

/** How this machine appears in the account's device list. */
export function machineName(): string {
  return hostname();
}

export async function signupMode(serverUrl: string): Promise<SignupMode> {
  return (await call<{ signup: SignupMode }>(serverUrl, "/v1/server")).signup;
}

export function createAccount(serverUrl: string, claimCode?: string): Promise<DeviceSession> {
  return call(serverUrl, "/v1/accounts", {
    method: "POST",
    body: { device: { name: machineName(), kind: "daemon" }, ...(claimCode ? { claimCode } : {}) },
  });
}

export function redeemPairingCode(serverUrl: string, code: string): Promise<DeviceSession> {
  return call(serverUrl, "/v1/pairing/redeem", {
    method: "POST",
    body: { code, device: { name: machineName(), kind: "daemon" } },
  });
}

export function createPairingCode(serverUrl: string, token: string): Promise<PairingCode> {
  return call(serverUrl, "/v1/pairing", { method: "POST", token });
}

export function pairingStatus(
  serverUrl: string,
  token: string,
  code: string,
): Promise<PairingCodeStatus> {
  return call(serverUrl, `/v1/pairing/${encodeURIComponent(code)}`, { token });
}

// ---------------------------------------------------------------------------------------------
// Pairing links: what the QR code holds. The end-to-end key rides along from device to device;
// the server only ever sees the 6-digit code. outbrief-app `src/pairing.ts` reads the same format.
// ---------------------------------------------------------------------------------------------

export const PAIRING_LINK_PREFIX = "outbrief://pair";

export interface PairingInvite {
  code: string;
  /** Absent when only the 6 digits were typed. */
  serverUrl?: string;
  /** `obk1_…`; absent when only the 6 digits were typed. */
  key?: string;
}

export function pairingLink(invite: Required<PairingInvite>): string {
  const params = new URLSearchParams({
    server: invite.serverUrl,
    code: invite.code,
    key: invite.key,
  });
  return `${PAIRING_LINK_PREFIX}?${params}`;
}

/** A pasted pairing link or 6 typed digits (spaces allowed); undefined when it is neither. */
export function parsePairingInput(text: string): PairingInvite | undefined {
  const trimmed = text.trim();
  const digits = trimmed.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) return { code: digits };
  if (!trimmed.startsWith(PAIRING_LINK_PREFIX)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  const code = url.searchParams.get("code") ?? "";
  const serverUrl = url.searchParams.get("server") ?? "";
  const key = url.searchParams.get("key") ?? "";
  if (!/^\d{6}$/.test(code) || !/^https?:\/\//.test(serverUrl)) return undefined;
  return { code, serverUrl, ...(key ? { key } : {}) };
}
