import QRCode from "qrcode";
import { type DaemonConfig, loadConfig, saveConfig } from "../config.ts";
import { E2eKeyring } from "../e2e/keyring.ts";
import { createPairingCode, pairingLink, pairingStatus } from "../pairing.ts";

const POLL_MS = 2_000;

/**
 * `outbrief-daemon pair`: shows a QR code and a 6-digit code another device joins this machine's
 * account with, and waits until one does (or the code expires).
 */
export async function pairCommand(_argv: string[]): Promise<void> {
  const config = loadConfig();
  if (!config) {
    process.stderr.write("还没有配对 — 先运行：outbrief-daemon login\n");
    process.exit(1);
  }
  const keyring = new E2eKeyring(config, saveConfig, () => undefined);
  await showPairing(config, keyring.view().key);
}

/**
 * Prints the QR code (server address + code + end-to-end key, device to device) and the code for
 * typing, then waits for the new device. The key is in the QR code only, never sent to the server.
 */
export async function showPairing(
  config: Pick<DaemonConfig, "serverUrl" | "token">,
  key: string,
): Promise<void> {
  const { code, expiresAt } = await createPairingCode(config.serverUrl, config.token);
  const link = pairingLink({ serverUrl: config.serverUrl, code, key });
  const qr = await QRCode.toString(link, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "L",
  });
  process.stdout.write(
    `\n${qr}\n` +
      "用手机 App「扫码加入」扫上面的二维码（会同时带上端到端密钥），\n" +
      `或者在 App 里输入配对码：${code.slice(0, 3)} ${code.slice(3)}（10 分钟内有效，只能用一次）\n` +
      "只输配对码时，手机还要输入同一个加密口令才能解开来电。\n\n" +
      `配对链接（给另一台电脑：outbrief-daemon login '<链接>'）：\n${link}\n\n` +
      "等待新设备加入…（Ctrl+C 退出，不影响配对码）\n",
  );
  const deadline = Date.parse(expiresAt);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const status = await pairingStatus(config.serverUrl, config.token, code).catch(() => null);
    if (status?.usedBy) {
      process.stdout.write(`「${status.usedBy.name}」已加入。\n`);
      return;
    }
  }
  process.stdout.write("配对码已过期。需要时再运行 outbrief-daemon pair。\n");
}
