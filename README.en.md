# outbrief-daemon

[中文](README.md)

The resident OutBrief process on each computer, in the same role as Multica's `multica daemon`.

- Clients (desktop app, phone app, browser) answer calls and send replies. They run nothing on this machine.
- [`outbrief-server`](https://github.com/outbriefapp/outbrief-server) is the only relay. It stores and forwards ciphertext. It has no key.
- This repo, `outbrief-daemon`: one process per computer. It encrypts local agent reports, generates the spoken brief with the model configured on this machine, holds the WebSocket to the server (the computer opens no inbound port), and resumes the original agent session when a reply comes back.

This page is how to install this process, how it pairs, and how briefs, encryption, and the agent hooks behave. The Chinese README is the reference for the local HTTP routes on port 8790.

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

The same flags work on `login` and `pair`: `--server <url>`, or `OUTBRIEF_SERVER_URL`. A bare 6-digit code also asks for the sentence from Settings → Encryption. A full `outbrief://pair?…` link carries the server and the end-to-end key, so that sentence is not needed.

```bash
# This computer creates the account. The terminal shows a QR code and a 6-digit code
node src/cli.ts login --server http://127.0.0.1:8787
# The account already exists. Paste the link from Settings → Devices → Add a device
node src/cli.ts login 'outbrief://pair?server=…&code=123456&key=obk1_…'
# 6 digits only. Also type the sentence from Settings → Encryption
node src/cli.ts login 123456
# Add another device later
node src/cli.ts pair
```

On a private server that has no owner yet, creating the account asks for the claim code from the server log (`Claim code: XXXX-XXXX-XXXX`). After that, new devices join with a pairing code. The server URL comes from the link, then from `--server`, then from `OUTBRIEF_SERVER_URL`, then from the prompt. The default prompt is `http://127.0.0.1:8787`.

`login` again keeps the Multica token, the model, the report language, and the end-to-end key already in `~/.outbrief/daemon.json`. If the daemon is running, `node src/cli.ts install` restarts it so the new device token is the one in use. A computer that paired before an upgrade keeps its token.

## Briefs

The spoken paragraphs, the cards, and the open questions are generated here, not on the server. One structured LLM call, then a check: every critical fact was spoken, and the spoken text is at most 60% of the source when the source is longer than 300 characters. A miss is rewritten once. Critical facts still missing after that are appended as one more section, titled by the model in the brief's language, and read aloud.

The language of that brief (speech, cards, conclusion, open questions, whatever language the original report used) is Settings → Voice → Report language in the app. The app writes it with `PUT /brief/language` into `brief.language` on startup and whenever it changes. The next brief uses it immediately. Before the app has set one, this computer's own language is used (macOS `AppleLanguages`, then `LC_ALL` / `LANG` / `Intl`, completed to a language-region tag). If none of those work, the language is `en-US`.

The model is Settings → LLM in the app. Save writes `llm.primary` in `~/.outbrief/daemon.json`. The next brief uses it. No restart. There is one channel. There is no backup.

```json
{
  "llm": {
    "primary": {
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "<your key>",
      "model": "deepseek-flash",
      "structuredOutput": "json_object"
    }
  }
}
```

Any OpenAI-compatible endpoint works. `structuredOutput` is chosen in the app and checked with Test connection:

- `json_schema` (the default): the request sends `response_format: json_schema` and the API enforces the schema.
- `json_object`: for models without `json_schema` (DeepSeek, Claude's OpenAI-compatible API, local Ollama, and others). The schema goes in the system prompt, the request sends `response_format: json_object`, a markdown fence is stripped, and the same schema validates the result. A result that does not match is a failed call.

A missing or malformed `baseUrl`, `apiKey`, or `model` counts as not configured. The startup log names the model and does not print the key. A failed call, or no configuration, still sends the report. The brief is `failed`, and the app reads the original text. Editing `daemon.json` by hand takes effect on the next start of the daemon. Saving from the app replaces `llm`. A hand-written `llm.fallback` is removed. It is not read.

A brief takes 5–60 seconds. The hook only waits 5 seconds, so the report is stored first:

1. `POST /report` accepts only a local process: `Host` is `127.0.0.1` or `localhost` plus the port, no `Origin`, `Content-Type: application/json`, body under about 0.8 MB. A page in a browser is rejected. The daemon records `sessionId → cwd`, writes `~/.outbrief/outbox.json` (temp file, then rename, mode 600), and returns `202 {"accepted": true}` before the brief exists. A finished Multica task is written to the same outbox.
2. Up to 3 briefs are generated at once, in arrival order. The result is written back to the outbox. A later send failure or a restart does not generate that brief again.
3. The daemon POSTs the sealed report to `/v1/daemon/events` (a local agent) or `/v1/daemon/multica-reports` (Multica). Network errors, 5xx, and 429 retry with backoff from 1 second up to 5 minutes, including across restarts. Any other 4xx is logged and dropped. `409 duplicate_task` means another computer already reported that Multica task. That counts as done.
4. Startup resumes every unfinished report in the outbox. Shutdown aborts a brief still being generated. The next start generates it.

## End-to-end encryption

The report, the brief, the reply, and a reply's failure reason are encrypted between this computer and the app. The server stores and forwards ciphertext. It has no key.

- The key is `e2e.key` in `~/.outbrief/daemon.json` (`obk1_…`, mode 600). The first `run` generates 32 random bytes. Settings → Encryption can replace it: the user types a sentence of at least 12 characters, PBKDF2-SHA256 (600,000 rounds) derives the `obk1_` key, and only the derived key is stored. The sentence is not stored. The app shows that one field. It does not show the derived key or the key id.
- The desktop app on this computer reads the key from `GET /e2e/key`, authenticated with the local key file. Another device gets it from the QR code. A 6-digit code alone does not carry the key, so that device must type the same sentence.
- A reply sealed with a different key cannot be opened. The daemon reports a content-free error, and the app shows it.

## Agent stop hooks

`node src/cli.ts hook claude-code` and `node src/cli.ts hook codex` are the Claude Code and Codex Stop hooks. When an agent turn ends, the hook POSTs the final reply to this daemon's `/report` (port `localPort` in `daemon.json`, default 8790).

- `install` writes `~/.claude/settings.json` and `~/.codex/hooks.json`. The command is `"<node>" "<this checkout>/src/cli.ts" hook claude-code` or `hook codex`. Running `install` again, or after the checkout moves, removes the previous OutBrief hook first, including one left by the old `outbrief-hook` package, so one turn does not ring twice. `uninstall` removes them. After the Codex command changes, trust the hook again inside Codex.
- Both Stop payloads arrive on stdin: `session_id`, `cwd`, `transcript_path`, `stop_hook_active`, `last_assistant_message`. An old Claude Code build with no `last_assistant_message` is read from the transcript. `stop_hook_active: true` (a second Stop after the hook itself continued the turn) is not reported.
- A Codex `session_id` is the thread id. Only a thread that has a rollout file under `$CODEX_HOME/sessions` (default `~/.codex/sessions`) is reported, because only that thread can be resumed. Internal turns, such as the TUI naming a task, are skipped.
- Inside a Multica task (`MULTICA_ISSUE_ID` / `MULTICA_TASK_ID`) the hook does not report. The daemon reads that report from Multica. Reporting here as well would ring twice.
- The hook waits 5 seconds. The daemon answers `202` as soon as it accepts the report. If the daemon is not running, the report is dropped. Every failure exits 0, so the agent is not blocked.

To check the hook without ringing the phone:

```bash
echo '{"session_id":"s1","cwd":"/tmp/demo","last_assistant_message":"Login module refactor is done."}' \
  | node src/cli.ts hook claude-code --dry-run

curl -X POST "http://127.0.0.1:8790/report?dryRun=1" -H "Content-Type: application/json" \
  -d '{"source":"generic","title":"demo","content":"Login module refactor is done. 42 tests passed."}'
```

`--dry-run` prints the parsed report and does not call the daemon. `?dryRun=1` validates and echoes the body. It does not enter the outbox and does not ring. Omitting `dryRun` sends a real report and rings a real call.

## Commands

| Command | What it does |
|---|---|
| `node src/cli.ts login` / `pair` | Create an account or join with a pairing code / show a QR code for a new device |
| `node src/cli.ts install` / `uninstall` | macOS: write or remove the Claude Code and Codex Stop hooks and the launchd agent |
| `node src/cli.ts run` | Stay connected to the server. This is the process `install` starts on macOS |
| `node src/cli.ts brief-eval <report files…>` | Generate briefs with the model in `daemon.json` and do not send them. Exit 1 when a critical fact is missing or the spoken text is over 60% |
| `node src/cli.ts hook claude-code` / `hook codex` | Stop hook entry. `--dry-run` prints the report and does not call the daemon |
| `pnpm lint` / `pnpm format` | Biome check / write |
| `pnpm typecheck` | `tsc` |
| `pnpm test` | Vitest |

## License

[OutBrief License](LICENSE) (Apache License 2.0 plus extra terms, following the [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)).
