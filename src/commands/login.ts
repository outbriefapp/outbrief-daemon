import * as readline from "node:readline";
import {
  configPath,
  type DaemonConfig,
  DEFAULT_LOCAL_PORT,
  loadConfig,
  saveConfig,
} from "../config.ts";
import { formatKey, keyFromPassphrase, MIN_PASSPHRASE_CHARS, parseKey } from "../e2e/crypto.ts";
import { E2eKeyring } from "../e2e/keyring.ts";
import {
  createAccount,
  type DeviceSession,
  type PairingInvite,
  parsePairingInput,
  redeemPairingCode,
  ServerApiError,
  signupMode,
} from "../pairing.ts";
import { showPairing } from "./pair.ts";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";

interface Prompt {
  question(prompt: string): Promise<string>;
  close(): void;
}

/**
 * Line prompts that also work with piped input: lines that arrive before they are asked for are
 * kept, and an ended input answers "" instead of throwing.
 */
function prompt(): Prompt {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let ended = false;
  rl.on("line", (line) => {
    const answer = waiting.shift();
    if (answer) answer(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    ended = true;
    for (const answer of waiting.splice(0)) answer("");
  });
  return {
    question(text) {
      process.stdout.write(text);
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) return Promise.resolve("");
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

const USAGE = `outbrief-daemon login [配对码 | 配对链接] [--server <地址>]

  不带参数：创建一个新账号（或者按提示输入配对码加入已有账号），然后显示二维码和 6 位配对码，
            用手机 App 扫码或输码把手机加进来。
  配对码：  在已有设备的「添加设备」里看到的 6 位数字，加入那个账号。
  配对链接：「添加设备」页复制的 outbrief://pair?… 链接，同时带上服务地址和端到端密钥。
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function serverError(err: unknown): string {
  if (!(err instanceof ServerApiError)) return String(err);
  switch (err.code) {
    case "invalid_pairing_code":
      return "配对码不对、已经用过或者过期了（10 分钟内有效，只能用一次）。在已有设备上重新「添加设备」拿一个新的。";
    case "invalid_claim_code":
      return "认领码不对。认领码在 server 的启动日志里（Claim code: XXXX-XXXX-XXXX），每次重启都会换一个。";
    case "signup_closed":
      return "这个 server 已经有主人，不再允许创建新账号。在已有设备上「添加设备」，用配对码加入。";
    case "rate_limited":
      return "尝试次数太多，过 10 分钟再试。";
    default:
      return err.message;
  }
}

/**
 * Pairs this machine with an account (outbrief-server ADR 0008). There is no login: the first
 * device creates an anonymous account, the others join it with a one-time code.
 *
 * - With a code or link: joins that account. A link also carries the server address and the
 *   end-to-end key; with bare digits the key comes from the passphrase set in the app.
 * - Without: creates an account (asking for the server's claim code when it has no owner yet)
 *   and shows a QR code + pairing code for the phone.
 */
export async function loginCommand(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const serverFlag = argv.indexOf("--server");
  const serverArg = serverFlag >= 0 ? argv[serverFlag + 1] : undefined;
  const positional = argv.filter(
    (arg, i) => !arg.startsWith("--") && (serverFlag < 0 || i !== serverFlag + 1),
  );
  const previous = loadConfig();

  const rl = prompt();
  try {
    let invite: PairingInvite | undefined;
    if (positional[0]) {
      invite = parsePairingInput(positional.join(" "));
      if (!invite)
        fail(
          `看不懂「${positional.join(" ")}」：要 6 位配对码或 outbrief://pair 链接。\n\n${USAGE}`,
        );
    }

    let serverUrl =
      invite?.serverUrl ?? serverArg?.trim() ?? process.env.OUTBRIEF_SERVER_URL?.trim() ?? "";
    if (!serverUrl) {
      const fallback = previous?.serverUrl ?? DEFAULT_SERVER_URL;
      serverUrl = (await rl.question(`Server 地址 [${fallback}]: `)).trim() || fallback;
    }
    serverUrl = serverUrl.replace(/\/+$/, "");

    if (!invite) {
      const answer = (
        await rl.question("输入配对码或配对链接加入已有账号；直接回车创建新账号: ")
      ).trim();
      if (answer) {
        invite = parsePairingInput(answer);
        if (!invite) fail("看不懂：要 6 位配对码或 outbrief://pair 链接。");
      }
    }

    let session: DeviceSession;
    let key: Buffer | null = null;
    if (invite) {
      // The key must be settled before the code is spent: a used code cannot be tried again.
      key = invite.key ? parseKey(invite.key) : await passphraseKey(rl);
      if (!key) fail("配对链接里的端到端密钥无效，请重新复制。");
      session = await redeemPairingCode(serverUrl, invite.code).catch((err: unknown) =>
        fail(`加入失败：${serverError(err)}`),
      );
    } else {
      session = await create(rl, serverUrl);
    }

    const config: DaemonConfig = {
      localPort: DEFAULT_LOCAL_PORT,
      claude: { permissionMode: "acceptEdits", addDirs: [] },
      codex: { sandbox: "workspace-write" },
      // Re-pairing keeps what the app set on this machine (Multica, LLM, language, key).
      ...previous,
      serverUrl,
      token: session.token,
      machineId: session.device.id,
      machineName: session.device.name,
      ...(key
        ? {
            e2e: {
              key: formatKey(key),
              source: invite?.key ? "random" : "passphrase",
              updatedAt: new Date().toISOString(),
            },
          }
        : {}),
    };
    saveConfig(config);
    // A new account starts with a random key (generated here if this machine has none yet).
    const keyring = new E2eKeyring(config, saveConfig, () => undefined);

    process.stdout.write(
      `\n已${invite ? "加入账号" : "创建账号"}，这台电脑是「${session.device.name}」。配置保存在 ${configPath()}。\n` +
        "如果 daemon 已经在运行，重启它才会用上新的令牌：outbrief-daemon install\n",
    );
    if (!invite) {
      process.stdout.write("\n现在把手机加进来：\n");
      await showPairing(config, keyring.view().key);
    }
  } finally {
    rl.close();
  }
}

async function create(rl: Prompt, serverUrl: string): Promise<DeviceSession> {
  const mode = await signupMode(serverUrl).catch((err: unknown) =>
    fail(`连不上 ${serverUrl}：${String(err)}`),
  );
  if (mode === "closed") fail(serverError(new ServerApiError(403, "signup_closed", "")));
  const claimCode =
    mode === "claim"
      ? (
          await rl.question(
            "这个 server 还没有主人。输入它启动日志里的认领码（Claim code: XXXX-XXXX-XXXX）: ",
          )
        ).trim()
      : undefined;
  return createAccount(serverUrl, claimCode).catch((err: unknown) =>
    fail(`创建账号失败：${serverError(err)}`),
  );
}

/**
 * Bare digits carry no key: the one the app uses must be derived from its passphrase. An app on
 * a random key cannot be matched this way; the pairing link can.
 */
async function passphraseKey(rl: Prompt): Promise<Buffer> {
  process.stdout.write(
    "只输配对码拿不到端到端密钥。输入 App「设置 → 加密」里设的密钥（那句话），\n" +
      "没设过就直接回车，改用「添加设备」页的配对链接：outbrief-daemon login '<配对链接>'\n",
  );
  const phrase = await rl.question("密钥: ");
  if (!phrase) fail("没有密钥就解不开这台电脑的来电。请改用配对链接。");
  if ([...phrase.normalize("NFC")].length < MIN_PASSPHRASE_CHARS) {
    fail(`密钥至少 ${MIN_PASSPHRASE_CHARS} 个字符。`);
  }
  return keyFromPassphrase(phrase);
}
