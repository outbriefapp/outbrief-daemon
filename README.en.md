# outbrief-daemon

[中文](README.md)

The resident OutBrief process on each computer, in the same role as Multica's `multica daemon`.

- Clients (desktop app, phone app, browser) answer calls and send replies. They run nothing on this machine.
- [`outbrief-server`](https://github.com/outbriefapp/outbrief-server) is the only relay. It stores and forwards ciphertext. It has no key.
- This repo, `outbrief-daemon`: one process per computer. It encrypts local agent reports, generates the spoken brief with the model configured on this machine, holds the WebSocket to the server (the computer opens no inbound port), and resumes the original agent session when a reply comes back.

The Chinese README has the brief generator, the end-to-end format, the local settings API, and the hook payload. This page is how to install this process, in which order, and how it pairs with the desktop app and the phone.

## Install order

Calls stay inside one anonymous account. Let this daemon create the account. The desktop app and the phone app join it.

1. **Deploy [outbrief-server](https://github.com/outbriefapp/outbrief-server).** Run exactly one process. On a private deploy (the default), every start prints a one-time claim code while the server has no owner yet: `Claim code: XXXX-XXXX-XXXX`. Write down the server URL. Phones and other computers must be able to open that URL. `http://127.0.0.1:8787` works only on the machine that runs the server. When a phone will pair, pass a LAN IP or a public `https://` URL as `--server`.
2. **Install this repo.** Next section. `login` asks for the claim code and prints a QR code. On macOS, run `install` after that.
3. **Install the desktop app ([outbrief-app](https://github.com/outbriefapp/outbrief-app))** on the same computer. `pnpm tauri build` writes installers to `src-tauri/target/release/bundle/`. For development, `pnpm tauri dev`. When the daemon is already running, the desktop app joins this daemon's account the first time it opens.
4. **Install the mobile app.** Same app repo. Generate the Android or iOS project locally, then compile: `pnpm tauri android init`, then `pnpm tauri android dev` or `pnpm tauri android build`. For iOS: `pnpm tauri ios init`, then `pnpm tauri ios dev` or `pnpm tauri ios build`. You need the [Tauri mobile prerequisites](https://tauri.app/start/prerequisites/). That repo does not ship a store binary. On a device that is already paired, open Settings → Devices → Add a device, or run `node src/cli.ts pair` here, and scan the QR code with the phone camera.

### Install this repo

Node ≥ 22.18 and pnpm 9. Run the commands in the checkout. Every `outbrief-daemon` below is `node src/cli.ts`. To type `outbrief-daemon` from any directory, run `pnpm link --global` once and put `pnpm bin -g` on `PATH`.

```bash
pnpm install
node src/cli.ts login --server http://127.0.0.1:8787
# macOS: start at login, plus the Claude Code / Codex Stop hooks
node src/cli.ts install
```

`login` with no code creates an account. If the server has no owner yet, it asks for the claim code, then prints a QR code. Paste a pairing code or an `outbrief://pair?…` link at the prompt to join an account that already exists. When you already have the link or the code:

```bash
node src/cli.ts login --server https://your-server.example 'outbrief://pair?server=…&code=123456&key=obk1_…'
node src/cli.ts login 123456
```

On macOS, `install` writes `~/Library/LaunchAgents/com.outbrief.daemon.plist` (start at login, restart if the process exits) and the Claude Code and Codex Stop hooks. The plist stores the absolute path of node and of this checkout's `src/cli.ts`, so leave the checkout where it is. Logs: `~/.outbrief/logs/daemon.out.log` and `daemon.err.log`. If the daemon is already running, run `install` again after a new `login` so it picks up the new token.

On Linux and Windows, `install` calls `launchctl` and stops there. After `login`, run the process under your own supervisor:

```bash
node src/cli.ts run
```

Write the Stop hooks yourself. The commands are:

```text
"<absolute path to node>" "<this checkout>/src/cli.ts" hook claude-code
"<absolute path to node>" "<this checkout>/src/cli.ts" hook codex
```

Claude Code reads `hooks.Stop` in `~/.claude/settings.json`. Codex reads `hooks.Stop` in `~/.codex/hooks.json`. After the Codex hook command changes, trust it again inside Codex.

### Pairing

There is no login and no shared password. The first device creates the account. Later devices join with a 6-digit code. The code lasts 10 minutes and works once. The QR code and the link look like `outbrief://pair?server=<server-url>&code=<6 digits>&key=obk1_…`. The server URL and the end-to-end key go from device to device. The server never sees the key. The `server` in the link is the `--server` you passed to `login`. The phone has to be able to open it.

| Already in the account | Device joining | What to do |
|---|---|---|
| Daemon running on this computer | Desktop app on the same computer | Automatic. The app reads `~/.outbrief/local-api.key` and asks `127.0.0.1:8790` for a pairing code and the key |
| Desktop app, or the daemon (`node src/cli.ts pair`) | Phone app | Scan the QR code from Settings → Devices → Add a device, or the QR code in the terminal |
| Phone, or an app on another computer | Daemon on a computer | Copy the command from Add a device and run `node src/cli.ts login 'outbrief://pair?…'` on that computer |
| Any paired device | Desktop app on another computer | Paste the pairing link into the welcome screen. The desktop app does not open the camera |
| 6 digits only | Daemon or app | Also enter the same sentence from Settings → Encryption (at least 12 characters). When that sentence was never set, use the QR code or the link that carries `key=` |

The app can create the account instead. On the welcome screen, enter the server URL and the claim code, then choose Create a new account. Copy the link from Add a device and `login` this computer with it. After the daemon on that computer is paired and running, the desktop app on that computer joins the daemon's account.

Phone only, no desktop app: after the server is up and `login` has printed a QR code, scan it with the phone. Multica, the LLM, and the report language on the phone are encrypted and relayed through the server to this daemon. This computer has to be online.

On a public server, set `OUTBRIEF_OPEN_SIGNUP=true`. The first device creates an account with no claim code.

Another device, after this computer is already paired:

```bash
node src/cli.ts pair
```

The command reference in the [Chinese README](README.md) (section「配对：账号与设备」) uses the same `login` / `pair` flags (`--server`, `OUTBRIEF_SERVER_URL`, a bare 6-digit code, or a full `outbrief://pair` link).

## Commands

| Command | What it does |
|---|---|
| `node src/cli.ts login` / `pair` | Create an account or join with a pairing code / show a QR code for a new device |
| `node src/cli.ts install` / `uninstall` | macOS: write or remove the Claude Code and Codex Stop hooks and the launchd agent |
| `node src/cli.ts run` | Stay connected to the server. This is the process `install` starts on macOS |
| `pnpm lint` / `pnpm format` | Biome check / write |
| `pnpm typecheck` | `tsc` |
| `pnpm test` | Vitest |

## License

[OutBrief License](LICENSE) (Apache License 2.0 plus extra terms, following the [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)).
