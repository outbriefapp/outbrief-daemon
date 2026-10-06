import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, outbriefHome } from "../config.ts";

// Absolute path to src/cli.ts, derived from this file's own URL.
function cliPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // thisFile = .../src/commands/install.ts  →  .../src/cli.ts
  return join(dirname(dirname(thisFile)), "cli.ts");
}

function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function codexHooksPath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.outbrief.daemon.plist");
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function hookCommands(cli: string): { claude: string; codex: string } {
  const node = process.execPath;
  return {
    claude: `"${node}" "${cli}" hook claude-code`,
    codex: `"${node}" "${cli}" hook codex`,
  };
}

interface StopHookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}

/** An OutBrief Stop hook from any checkout, including the retired outbrief-hook repo. */
function isOutbriefHook(command: string | undefined): boolean {
  return /outbrief-(daemon|hook)\/src\/cli\.ts"?\s+(hook\s+)?(claude-code|codex)\b/.test(
    command ?? "",
  );
}

/** Drops every OutBrief hook, then entries left without hooks; other tools' hooks stay as they are. */
export function withoutOutbriefHooks(stop: StopHookEntry[]): StopHookEntry[] {
  return stop
    .map((entry) =>
      Array.isArray(entry.hooks)
        ? { ...entry, hooks: entry.hooks.filter((h) => !isOutbriefHook(h.command)) }
        : entry,
    )
    .filter((entry) => !Array.isArray(entry.hooks) || entry.hooks.length > 0);
}

/**
 * Makes `command` the only OutBrief entry in a Stop hook list, replacing hooks from other checkouts
 * so an agent turn never rings twice. Returns whether the list changed.
 */
function setOutbriefStopHook(container: Record<string, unknown>, entry: StopHookEntry): boolean {
  const before = Array.isArray(container.Stop) ? (container.Stop as StopHookEntry[]) : [];
  const after = [...withoutOutbriefHooks(before), entry];
  container.Stop = after;
  return JSON.stringify(before) !== JSON.stringify(after);
}

function daemonPathEnv(): string {
  const nodeDir = dirname(process.execPath);
  const current = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const dirs = current.split(":");
  return dirs.includes(nodeDir) ? current : `${nodeDir}:${current}`;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export async function installCommand(_argv: string[]): Promise<void> {
  const config = loadConfig();
  if (!config) {
    process.stderr.write("Not paired — run: outbrief-daemon login\n");
    process.exit(1);
  }

  const cli = cliPath();
  const { claude: hookCmd, codex: codexHookCmd } = hookCommands(cli);

  // 1. Claude Code Stop hook — ~/.claude/settings.json
  {
    const path = claudeSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    let settings: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch (err) {
        process.stderr.write(
          `Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    }

    // Navigate/create: hooks.Stop[0].hooks[]
    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown>;
    if (
      setOutbriefStopHook(hooks, { matcher: "", hooks: [{ type: "command", command: hookCmd }] })
    ) {
      writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
      process.stdout.write(`Wrote Claude Code Stop hook to ${path}\n`);
    } else {
      process.stdout.write(`Claude Code Stop hook already present in ${path}\n`);
    }
  }

  // 2. Codex Stop hook — ~/.codex/hooks.json
  {
    const path = codexHooksPath();
    mkdirSync(dirname(path), { recursive: true });
    let codexHooks: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        codexHooks = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch (err) {
        process.stderr.write(
          `Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    }

    if (!codexHooks.hooks || typeof codexHooks.hooks !== "object") {
      codexHooks.hooks = {};
    }
    const h = codexHooks.hooks as Record<string, unknown>;
    if (setOutbriefStopHook(h, { hooks: [{ type: "command", command: codexHookCmd }] })) {
      writeFileSync(path, `${JSON.stringify(codexHooks, null, 2)}\n`);
      process.stdout.write(`Wrote Codex Stop hook to ${path}\n`);
    } else {
      process.stdout.write(`Codex Stop hook already present in ${path}\n`);
    }
  }

  // 3. macOS launchd plist
  {
    const home = outbriefHome();
    const logsDir = join(home, "logs");
    mkdirSync(logsDir, { recursive: true });

    const dest = plistPath();
    mkdirSync(dirname(dest), { recursive: true });

    const node = process.execPath;
    const pathEnv = daemonPathEnv();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.outbrief.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(cli)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OUTBRIEF_HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logsDir, "daemon.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logsDir, "daemon.err.log"))}</string>
</dict>
</plist>
`;
    writeFileSync(dest, plist);
    process.stdout.write(`Wrote plist to ${dest}\n`);

    // 4. Load via launchctl
    try {
      execSync(`launchctl load -w "${dest}"`, { stdio: "pipe" });
      process.stdout.write("Loaded com.outbrief.daemon via launchctl.\n");
    } catch (err) {
      const detail =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: Buffer | string }).stderr)
          : err instanceof Error
            ? err.message
            : String(err);
      process.stderr.write(`launchctl load failed: ${detail}\n`);
      process.exit(1);
    }
  }

  process.stdout.write(
    "outbrief-daemon installed. It will start on login and restart if it exits.\n",
  );
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

export async function uninstallCommand(_argv: string[]): Promise<void> {
  const dest = plistPath();

  // Unload first
  if (existsSync(dest)) {
    try {
      execSync(`launchctl unload -w "${dest}"`, { stdio: "pipe" });
      process.stdout.write("Unloaded com.outbrief.daemon.\n");
    } catch (err) {
      process.stderr.write(
        `launchctl unload failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    unlinkSync(dest);
    process.stdout.write(`Removed ${dest}\n`);
  } else {
    process.stdout.write("Plist not found — already uninstalled or never installed.\n");
  }

  // Remove Claude Code hook
  {
    const path = claudeSettingsPath();
    if (existsSync(path)) {
      try {
        const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const hooks = settings.hooks as Record<string, unknown> | undefined;
        if (hooks && Array.isArray(hooks.Stop)) {
          hooks.Stop = withoutOutbriefHooks(hooks.Stop as StopHookEntry[]);
          writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
          process.stdout.write(`Removed Claude Code hook from ${path}\n`);
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Remove Codex hook
  {
    const path = codexHooksPath();
    if (existsSync(path)) {
      try {
        const codexHooks = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const h = codexHooks.hooks as Record<string, unknown> | undefined;
        if (h && Array.isArray(h.Stop)) {
          h.Stop = withoutOutbriefHooks(h.Stop as StopHookEntry[]);
          writeFileSync(path, `${JSON.stringify(codexHooks, null, 2)}\n`);
          process.stdout.write(`Removed Codex hook from ${path}\n`);
        }
      } catch {
        /* ignore */
      }
    }
  }

  process.stdout.write("outbrief-daemon uninstalled.\n");
}
