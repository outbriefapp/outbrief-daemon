#!/usr/bin/env node
// Commands load lazily: `hook` runs on every agent turn and must not pull in the LLM/WebSocket deps.
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "login":
    await (await import("./commands/login.ts")).loginCommand(rest);
    break;
  case "pair":
    await (await import("./commands/pair.ts")).pairCommand(rest);
    break;
  case "install":
    await (await import("./commands/install.ts")).installCommand(rest);
    break;
  case "uninstall":
    await (await import("./commands/install.ts")).uninstallCommand(rest);
    break;
  case "hook":
    await (await import("./commands/hook.ts")).hookCommand(rest);
    break;
  case "run":
    await (await import("./commands/run.ts")).runCommand();
    break;
  case "brief-eval":
    await (await import("./commands/briefEval.ts")).briefEvalCommand(rest);
    break;
  default:
    process.stderr.write(
      `outbrief-daemon: unknown command "${cmd ?? ""}"\nCommands: login pair install uninstall run hook brief-eval\n`,
    );
    process.exit(1);
}
