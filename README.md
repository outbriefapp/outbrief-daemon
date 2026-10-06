# outbrief-daemon

[English](README.en.md)

每台用户电脑上的 OutBrief 常驻进程，相当于 Multica 的 `multica daemon`。

三层架构中的位置：

- 客户端（桌面 App、手机 App、网页）：接来电、提交回复，不在本机执行任何东西。
- 云端 [`outbrief-server`](https://github.com/outbriefapp/outbrief-server)：唯一的中转，负责暂存和转发密文、回复投递队列。它没有密钥，读不到汇报、简报和回复（端到端加密，见下文）。
- 本仓库 `outbrief-daemon`：一台电脑一个，常驻后台。

职责：

- 接收本机 Agent 完成回调（`outbrief-daemon hook`，见下文「Agent 完成回调」）上报的汇报，在本地记下 `sessionId → cwd`，用本机配置的大模型生成简报，再把汇报连同简报加密后发给 server（server 不生成简报，也解不开）。
- 主动向 server 建立 WebSocket 长连接。用户电脑不开入站端口。
- 收到任意客户端发来的回复后，在本机用 `--resume` 接着原会话运行 Agent，然后上报 `delivered` 或 `failed`。
  - 每条回复最多执行一次：还在执行时 server 因重连重发的同一条会被忽略；daemon 在执行途中重启的，重启后直接报 `failed`（结果未知，不重跑）。
  - Agent 的 stdout 直接丢弃（它的答复会作为下一次汇报回来），stderr 只留最后 1000 字作失败原因；运行超过 60 分钟就停掉并报 `failed`。
- 权限模式和允许的目录只在本机配置，server 下发的只有回复文本和事件 ID。
- 保存用户自己的 Multica API Token（只存在本机 `~/.outbrief/daemon.json`，权限 600，不上传 server）：用它监听选中的 Multica 工作区（可以选多个，每个工作区一条连接），任务完成后读出 Agent 的汇报评论，连同 issue 所属项目名、优先级和更新时间，生成简报后通过 `POST /v1/daemon/multica-reports` 交给 server 生成来电；挂断后的回复由 server 排队发回这台机器，daemon 以用户身份发到 Multica。电脑关机或 daemon 没运行时，Multica 任务不会来电，回复等 daemon 上线后补发（24 小时内）。

## 安装顺序

来电只在同一个匿名账号里转发。推荐让本仓库（daemon）创建账号，桌面 App 和手机 App 都加入这个账号。

1. **部署 [outbrief-server](https://github.com/outbriefapp/outbrief-server)**。只跑一个进程。私有化部署（默认）在还没有主人时，每次启动的日志里打印一次性认领码 `Claim code: XXXX-XXXX-XXXX`。记下服务地址。手机和别的电脑要能访问这个地址；`http://127.0.0.1:8787` 只有部署 server 的那台机器自己能用。给手机配对时，这里的 `--server` 填局域网 IP 或公网 `https://` 地址。
2. **安装本仓库**。见下一节。`login` 时输入认领码，终端打出二维码。macOS 上再 `install`。
3. **在同一台电脑上安装桌面 App（[outbrief-app](https://github.com/outbriefapp/outbrief-app)）**。`pnpm tauri build`，安装包在 `src-tauri/target/release/bundle/`。开发时用 `pnpm tauri dev`。daemon 已经在运行时，桌面端第一次打开会自动加入这台 daemon 的账号。
4. **安装手机 App**。同一仓库，Android / iOS 工程在本机生成后再编译：`pnpm tauri android init`，然后 `pnpm tauri android dev` 或 `pnpm tauri android build`；iOS 用 `pnpm tauri ios init`，然后 `pnpm tauri ios dev` 或 `pnpm tauri ios build`。需要 [Tauri 的移动端环境](https://tauri.app/start/prerequisites/)。仓库里没有应用商店安装包。打开已配对设备的「设置 → 设备 → 添加设备」，或在电脑上执行 `node src/cli.ts pair`，用手机摄像头扫二维码。

### 安装本仓库

需要 Node ≥ 22.18、pnpm 9。命令都在仓库目录里执行。下文的 `outbrief-daemon` 就是 `node src/cli.ts`。想在任意目录直接敲 `outbrief-daemon`，执行一次 `pnpm link --global`，并确认 `pnpm bin -g` 在 `PATH` 里。

```bash
pnpm install
node src/cli.ts login --server http://127.0.0.1:8787
# macOS：开机自启 + Claude Code / Codex 的 Stop hook
node src/cli.ts install
```

`login` 不带参数时：server 还没有主人就询问认领码并创建账号，然后显示二维码；提示符处粘贴配对码或 `outbrief://pair?…` 则加入已有账号。已经有账号时：

```bash
node src/cli.ts login --server https://your-server.example 'outbrief://pair?server=…&code=123456&key=obk1_…'
node src/cli.ts login 123456
```

`install` 在 macOS 上写入 `~/Library/LaunchAgents/com.outbrief.daemon.plist`（登录时启动、进程退出后拉起）和 Claude Code、Codex 的 Stop hook。plist 里是 node 和本仓库 `src/cli.ts` 的绝对路径，仓库留在原地。日志在 `~/.outbrief/logs/daemon.out.log` 和 `daemon.err.log`。daemon 已经在跑时，重新 `login` 之后再执行一次 `install`，新令牌才会生效。

Linux 和 Windows 上 `install` 会去调用 `launchctl`，到这一步就停住。这些系统在 `login` 之后用自己的进程管理器运行 `node src/cli.ts run`。Stop hook 写进配置，命令分别是：

```text
"<node 绝对路径>" "<本仓库>/src/cli.ts" hook claude-code
"<node 绝对路径>" "<本仓库>/src/cli.ts" hook codex
```

Claude Code 放在 `~/.claude/settings.json` 的 `hooks.Stop`，Codex 放在 `~/.codex/hooks.json` 的 `hooks.Stop`。Codex 的 hook 命令变了之后要在 Codex 里重新信任一次。

### 配对

没有登录，也没有共享口令。谁先装谁建账号，后来的设备用 6 位配对码加入。配对码 10 分钟有效、只能用一次。二维码和配对链接是 `outbrief://pair?server=<服务地址>&code=<6位>&key=obk1_…`。服务地址和端到端密钥由设备直接交给设备，server 看不到密钥。链接里的 `server` 就是 `login --server` 的地址，手机必须能访问它。

| 已在账号里 | 要加入的设备 | 怎么做 |
|---|---|---|
| 这台电脑的 daemon 正在运行 | 同一台电脑的桌面 App | 自动。App 用本机 `~/.outbrief/local-api.key` 向 `127.0.0.1:8790` 要配对码和密钥 |
| 桌面 App，或 daemon（`node src/cli.ts pair`） | 手机 App | 手机扫「设置 → 设备 → 添加设备」或终端里的二维码 |
| 手机或另一台电脑上的 App | 一台电脑的 daemon | 在「添加设备」页复制命令，在那台电脑上执行 `node src/cli.ts login 'outbrief://pair?…'` |
| 任意已配对设备 | 另一台电脑的桌面 App | 桌面端把配对链接贴进欢迎页。桌面端不开摄像头 |
| 只拿到 6 位数字 | daemon 或 App | 再输入「设置 → 加密」里的同一句话（至少 12 个字符）。没设过这句话时，用带 `key=` 的二维码或配对链接 |

先打开 App、由 App 创建账号也可以：欢迎页填服务地址和认领码，点「创建新账号」，再用「添加设备」里的链接在电脑上 `login`。同一台电脑上的 daemon 配对并运行之后，这台电脑的桌面 App 加入的是 daemon 所在的账号。

只有手机、不装桌面 App：server 和 daemon `login` 做完后，用手机扫终端里的二维码。手机上的 Multica、大模型、汇报语言经 server 加密转给这台电脑的 daemon，电脑要在线。

公共云端把 server 的 `OUTBRIEF_OPEN_SIGNUP=true` 打开后，第一台设备直接建账号，认领码不用填。

## 简报生成

简报（来电里念给用户听的口播段落、卡片和待决问题）在 daemon 里生成：一次结构化 LLM 调用，然后检查每条 critical 事实都讲到了、口播不超过原文 60 %（原文 300 字以上时），不满足就重写一次，重写后仍漏掉的 critical 事实追加一段「补充说明」照读。

简报用哪种语言写（口播、卡片、结论、待决问题都是这种语言，不管汇报原文是什么语言）由 App「设置 → 语音 → 汇报语言」决定：youtube-dubbing-extension 目标语言里有 Azure 声音的 90 个 locale（如 `zh-CN`、`zh-TW`、`es-MX`），默认跟随系统。App 每次启动和切换时通过 `PUT /brief/language` 写进 `daemon.json` 的 `brief.language`，下一份简报立即生效；提示词里的语言名用 `Intl.DisplayNames` 取（如「墨西哥西班牙语」「中文（繁体，台湾）」），末尾「补充说明」段的标题也由大模型按这个语言给出。App 还没设过时按这台电脑的语言（macOS 的首选语言 `AppleLanguages`，再看 `LC_ALL` / `LANG` / `Intl`，补全成「语言-地区」），都不可用时用 `en-US`。

用哪个大模型在 App「设置 → 大模型」里设：选服务商、填 Key 和模型，保存后 App 通过下文的 `PUT /llm/settings` 写进本机 `~/.outbrief/daemon.json` 的 `llm.primary`，下一份简报立即生效，不用重启 daemon。只有这一个接口，没有备用通道（原来 ADR 0004 的主备切换和熔断已经去掉）：

```json
{
  "llm": {
    "primary": {
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "<你的 key>",
      "model": "deepseek-flash",
      "structuredOutput": "json_object"
    }
  }
}
```

- 兼容 OpenAI 的接口都可以。简报是结构化 JSON，`structuredOutput` 决定怎么让模型按格式输出，在 App 里选，用「测试连接」检查：
  - `json_schema`（默认）：请求带 `response_format: json_schema`，由接口强制约束，最稳。
  - `json_object`：给不支持 json_schema 的模型用（DeepSeek、Claude 的 OpenAI 兼容接口、Ollama 本地模型等）。把 JSON Schema 写进系统提示词，请求带 `response_format: json_object`，用 AI SDK 的 `extractJsonMiddleware` 去掉模型可能包上的 markdown 代码块，最后用同一个 zod schema 校验，不符合就算这次调用失败。
  - 两种方式和模型不绑定：内置服务商只是带一个默认值，用户可以任意组合。
- `timeoutMs` 可选，默认 30000；`reasoningEffort` 只在写了时才发。这两项只能手工加，从 App 保存时接口地址和模型都没变就保留，换了就去掉（别家接口不一定认 `reasoning_effort`）。从 App 保存会整个替换 `llm`，手工留下的 `llm.fallback` 会被删掉（本来也不再读取）。
- 缺 `baseUrl` / `apiKey` / `model` 或格式不对视为没配。启动日志会写用的是哪个模型（不打印 key）。
- 调用失败（报错、非 2xx、超时、输出不符合 schema、被内容过滤）或者没配，汇报照样发给 server，只是简报是 `failed`（没配时 `llmCalls` 为 0，错误是「这台电脑没有配置大模型（在 App「设置 → 大模型」里填写）」）：来电时客户端直接读原文。
- 手工改 `daemon.json` 要重启 daemon 才生效。

### 发件箱（outbox）

生成简报要 5～60 秒，而 hook 只等 5 秒，所以汇报先落盘再慢慢处理：

1. hook 的 `POST /report`：只接受本机进程的请求（`Host` 必须是 `127.0.0.1` / `localhost` 加端口、不能带 `Origin`、`Content-Type` 必须是 `application/json`、请求体不超过约 0.8 MB），网页发来的请求一律拒绝，免得随便一个网页就能让用户手机响。然后校验、记下 `sessionId → cwd`、写入 `~/.outbrief/outbox.json`（先写临时文件再 rename，权限 600），然后立刻回 `202 {"accepted": true}`，这时简报还没有生成。Multica 任务完成后同样只是写入发件箱。
2. 后台最多同时生成 3 份简报（按到达顺序开始）。生成结果写回发件箱，之后发送失败或 daemon 重启都不会重新生成。
3. 连同简报 POST 给 server：`/v1/daemon/events`（本机 Agent）或 `/v1/daemon/multica-reports`（Multica）。网络错误、5xx、429 按指数退避重试（1 秒起，最长 5 分钟），跨重启继续；其他 4xx 记日志后丢弃；`409 duplicate_task` 表示别的电脑已经报过这个 Multica 任务，视为完成。
4. daemon 启动时恢复发件箱里所有未完成的汇报；退出时中断正在生成的简报，下次启动重新生成。

## 端到端加密

汇报、简报、挂断后的回复、回复失败的原因都在这台电脑和用户的 App 之间加解密，server 只存、只转发密文（outbrief-server ADR 0007）：

- 密钥存在 `~/.outbrief/daemon.json` 的 `e2e.key`（`obk1_…`，权限 600）。第一次 `run` 时随机生成 32 字节；也可以在 App「设置 → 加密」里自己设一个密钥：用户填一句话（接口里叫 `passphrase`），用 PBKDF2-SHA256 60 万次算出 `obk1_` 密钥，只保存算出的密钥，不保存那句话。App 界面上只有这一个「密钥」输入框，算出的 `obk1_` 密钥和 `keyId` 都不显示。
- 同一台电脑上的桌面端通过下面的 `GET /e2e/key`（本机密钥鉴权）自动拿到密钥；别的设备扫这台电脑或已有设备显示的二维码时一起拿到，只输 6 位配对码时要输入同一个密钥（同一句话）。
- 算法：AES-256-GCM，每次随机 12 字节 IV，AAD 标明用途（汇报 / 某个事件的回复 / 某个回复的错误）。密文格式 `ob1.<keyId>.<iv>.<密文>`，`keyId` 用来区分「密钥不一致」和「数据损坏」，只在程序内部用。实现见 `src/e2e/crypto.ts`，App 的 `src/e2e/crypto.ts` 用 WebCrypto 实现同一格式，两边单测用同一组测试向量。
- 明文只留 server 路由要用的：来源（claude-code / codex / multica）、发生时间、Multica 任务 id（同一任务只来一次电）。
- 回复用别的密钥加密时，daemon 解不开，回一个不含内容的明文错误「无法解密回复……」，App 里能看到。

## Agent 完成回调（hook）

`outbrief-daemon hook <claude-code|codex>` 注册成 Claude Code 和 Codex 的 Stop hook，每轮 Agent 结束时把最终回复交给本机 daemon 的 `POST /report`（端口取 `~/.outbrief/daemon.json` 的 `localPort`，默认 8790）。原来单独的 `outbrief-hook` 仓库已并入这里。

- `outbrief-daemon install` 负责写配置：`~/.claude/settings.json` 和 `~/.codex/hooks.json` 的 `Stop`，命令是 `"<node>" "<本仓库>/src/cli.ts" hook claude-code|codex`。重复执行或换了目录再装，都会先删掉旧的 OutBrief hook（包括原 `outbrief-hook` 的），不会一轮响两次；`uninstall` 同样全部删掉。Codex 的 hook 命令变了之后要在 Codex 里重新信任一次。
- 两家的 Stop payload 都走 stdin，字段相同：`session_id`、`cwd`、`transcript_path`、`stop_hook_active`、`last_assistant_message`。Claude Code 老版本没有 `last_assistant_message` 时读 transcript。`stop_hook_active` 为真（hook 强制续跑后的再次 Stop）不上报。
- Codex 的 `session_id` 就是线程 id。只上报 `$CODEX_HOME/sessions`（默认 `~/.codex/sessions`）里有 rollout 文件的线程，也就是能被 `codex resume` 打开的线程；TUI 后台“生成任务标题”这类内部轮次会被跳过。
- 在 Multica 任务里（有 `MULTICA_ISSUE_ID` / `MULTICA_TASK_ID`）不上报：daemon 会从 Multica 读汇报，这里再报会来两次电。
- 5 秒超时，daemon 收下就回 `202`；daemon 没运行时汇报直接丢弃。任何失败都 `exit 0`，不影响 Agent。`cli.ts` 按子命令懒加载，hook 只依赖 Node 内置模块（路径和端口取自 `src/home.ts`，不经过 `config.ts`），所以 checkout 的 `node_modules` 被删掉（例如 Multica 清理已完成任务的工作目录）时 hook 照样能跑，有测试守着。

每条进了 `/report` 的汇报都会给用户打一通电话。只想检查 hook 和 daemon、不想来电时用 dry-run：

```bash
# hook 解析出的汇报，只打印，不发给 daemon
echo '{"session_id":"s1","cwd":"/tmp/demo","last_assistant_message":"登录模块重构完成。"}' \
  | node src/cli.ts hook claude-code --dry-run

# daemon 只校验并原样返回，不入发件箱、不来电
curl -X POST "http://127.0.0.1:8790/report?dryRun=1" -H "Content-Type: application/json" \
  -d '{"source":"generic","title":"demo","content":"登录模块重构完成，42 个测试通过。"}'
```

去掉 `?dryRun=1` 就是真的发一条汇报、真的来电。Agent 自测不要这样做（见 [AGENTS.md](AGENTS.md)）。

## 配对：账号与设备

安装顺序、桌面端自动加入、手机扫码见上文「安装顺序」。下面是这台电脑上的命令。

没有登录，也没有共享口令（outbrief-server ADR 0008）。账号是匿名的，每台设备（这台电脑、桌面 App、手机）有自己的令牌；谁先装谁建账号，其他设备用 6 位配对码加入。

```bash
# 先装 daemon（比如只有 daemon + 手机）：创建账号，终端里显示二维码和 6 位配对码，手机扫码或输码加入
outbrief-daemon login
# 已经有账号（App 先装）：App「设置 → 设备 → 添加设备」里复制配对链接，在这台电脑上运行
outbrief-daemon login 'outbrief://pair?server=…&code=123456&key=obk1_…'
# 或者只输 6 位配对码：还要输入 App「设置 → 加密」里设的密钥（那句话）
outbrief-daemon login 123456
# 之后想再加一台设备
outbrief-daemon pair
```

- 服务地址：配对链接里带着；否则用 `--server <地址>`、`OUTBRIEF_SERVER_URL`，或者按提示输入（默认 `http://127.0.0.1:8787`）。
- 私有化部署的 server 还没有主人时，创建账号要输入 server 启动日志里的认领码（`Claim code: XXXX-XXXX-XXXX`）；有主人之后只能用配对码加入。
- 二维码 / 配对链接同时带着这台电脑的端到端密钥，由设备直接传给设备，server 看不到。只输 6 位码拿不到密钥，所以另一端要输入同一个加密口令。
- 这台电脑的设备令牌（`obm_…`）存在 `~/.outbrief/daemon.json`。重新 `login` 会保留本机的 Multica、大模型、汇报语言和密钥设置；daemon 在运行时要重启（`outbrief-daemon install`）才用上新令牌。升级前配对过的电脑令牌照常有效，不用重新配对。
- 在任意一台设备的「设置 → 设备」里可以看到账号下的所有设备，逐台移除。

## 本机设置接口

桌面端「设置 → Multica」「设置 → 大模型」直接请求本机 `http://127.0.0.1:8790`，令牌不经过 server。每个请求都要带本机密钥 `Authorization: Bearer <~/.outbrief/local-api.key 的内容>`：daemon 第一次 `run` 时生成这个文件（权限 600），只有这台电脑的当前用户读得到，桌面 App 通过 Tauri 读它，网页读不到；`Host` 必须是本机回环地址。

没有桌面 App 时（只有手机），同样的请求由手机用端到端密钥加密，经 server 的 `POST /v1/devices/<这台电脑>/settings` 通过 WebSocket 转给 daemon；daemon 解密、执行，把结果加密后原路返回，server 读不到内容。`/e2e/*` 和 `/local/*` 只能在本机调用，经 server 转发的一律 `403 not_relayed`；手机的密钥和这台电脑不一致时返回 `400 undecryptable_request`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/multica/settings` | `{ settings, status }`；`settings` 只带监听的工作区 `workspaces` 和 `tokenHint`，从不返回令牌；`status.workspaces` 是每个工作区各自的连接状态 |
| `POST` | `/multica/workspaces` | `{ token? }` → 这个令牌能访问的工作区（不带令牌就用已保存的）；无效 `422 invalid_multica_token`，没保存过 `422 multica_not_configured` |
| `PUT` | `/multica/settings` | `{ token?, workspaceIds }`：要监听的工作区，不带令牌就沿用已保存的、只改工作区（旧版 App 发的 `{ token, workspaceId }` 当作只有一个），先向 Multica 校验，再保存并重连；`422 invalid_multica_token` / `workspace_not_found` |
| `DELETE` | `/multica/settings` | 删除令牌并断开 |
| `POST` | `/multica/issues` | `{ issues: [{ workspaceId, issueId }] }`（最多 100 个）→ `{ issues }`：这些 issue 现在的项目、优先级、更新时间，桌面端「来电」页按它排序；删掉或无权访问的 issue 不返回；没设置令牌 `422 multica_not_configured` |
| `GET` | `/multica/dispatch/options` | 主动派单能选的 `{ projects, agents }`：第一个监听的工作区里没完成、没取消的项目；每个 Agent 带 `online`（它的 Multica runtime 所在电脑在线），不在线的 Multica 不让派单。`POST` 同一路径带 `{ workspaceId }` 读别的监听工作区 |
| `POST` | `/multica/uploads` | `{ name, type, data, workspaceId? }`（一张图片，base64）→ `{ attachment: { id, filename, markdownUrl } }`：派单的图片一张一张传，daemon 转给 Multica `POST /api/upload-file`（不带 issue）。张数不限、每张最大 100 MB，和 Multica 自己的限制一致（它的 `maxUploadSize`，网页端 `MAX_FILE_SIZE`，都没有张数上限；YOUT-226）；不是图片或超过 100 MB `400 invalid_dispatch`。请求体最大 140 MB |
| `POST` | `/multica/dispatches` | `{ projectId, agentId, prompt, attachments?, workspaceId? }` → `{ dispatch }`：在 `workspaceId`（不带就是第一个监听的工作区）调 Multica 智能创建（`POST /api/issues/quick-create`），由选中的 Agent 按用户说的话写 issue（标题、描述、优先级、截止日期都由它从原话里提取，默认指派给它自己），立即返回 `state: "creating"`。`attachments` 是上面传好的图片：把 `![文件名](markdownUrl)` 接在原话后面、id 放进 `attachment_ids`——和 Multica 网页的智能创建一样，Agent 把图片留在 issue 描述里，建 issue 时绑定到它上面；记录里 `prompt` 只存原话，`images` 存张数。Agent 不能运行 `422 agent_unavailable`（`message` 是 Multica 给的原因）、项目 / Agent 不存在 `422 project_not_found` / `agent_not_found`，原话和图片都没有、原话超过 8000 字 `400 invalid_dispatch` |
| `GET` | `/multica/dispatches` | `{ dispatches }`：从这台电脑派出的单（最多 100 条，新的在前，存在 `~/.outbrief/dispatches.json`），每次读都向 Multica 刷新：还在创建的看 Agent 的任务（任务关联上 issue → `created`；任务失败 / 取消 → `failed` / `cancelled`；任务完成 1 分钟后还没有 issue → `failed`），已创建的读 issue 现在的标题、状态、优先级 |
| `POST` | `/multica/dispatches/lookup` | `{ id }` → `{ dispatch }`：只刷新这一条（App 的「呼叫中」页轮询它）；`422 dispatch_not_found` |
| `POST` | `/multica/dispatches/cancel` | `{ id }` → `{ dispatch }`：还在创建时取消 Multica 任务，已经建好 issue 的不动 |
| `GET` | `/e2e/key` | 仅本机：这台电脑的端到端密钥 `{ key, keyId, source, updatedAt }`，本机桌面端用它解密来电、加密回复 |
| `GET` | `/llm/settings` | `{ channel }`：生成简报用的接口，只有 `baseUrl`、`model`、`keyHint`、`structuredOutput`，从不返回 Key；没配是 `null` |
| `PUT` | `/llm/settings` | `{ baseUrl, apiKey?, model, structuredOutput? }`（`json_schema` 默认 / `json_object`）：保存并立即生效（不带 `apiKey` 沿用已保存的），返回 `{ channel }`；`422 invalid_llm_settings` / `llm_key_required` |
| `DELETE` | `/llm/settings` | 删掉，之后简报都是 `failed`；返回 `{ channel: null }` |
| `GET` | `/brief/language` | `{ language, source }`：简报的语言（BCP 47「语言-地区」，如 `zh-CN`、`es-MX`）；`source` 是 `app`（App 设的）或 `system`（还没设，按本机语言） |
| `PUT` | `/brief/language` | `{ language }`：保存并立即生效；`422 invalid_language` |
| `POST` | `/local/pairing` | 仅本机：`{ serverUrl, code, key, expiresAt, link }`。桌面 App 用它加入这台电脑所在的账号，并拿到这台电脑的端到端密钥（升级前的桌面 App 也靠它把旧的共享口令换成自己的设备令牌） |
| `PUT` | `/e2e/key` | 换密钥：`{ passphrase }`（至少 12 个字符，只保存由它算出的密钥）、`{ key: "obk1_…" }`（App 已经不用这种方式）或 `{ random: true }`；`422 passphrase_too_short` / `invalid_key` |

`OUTBRIEF_MULTICA_API_URL` 可以改 Multica 地址（默认 `https://api.multica.ai`）。

读 Multica（`GET`：issue、评论、项目、Agent、runtime、Agent 的任务）时，网络错误、5xx、429 最多重试 3 次（等 0.5 / 1 / 2 秒）；网络错误的日志带上原因（例如 `fetch failed (ECONNRESET)`）。写（发评论、上传派单图片、派单、取消派单）不重试，免得同一条回复发两次、同一个单派两次。

## 常用命令

| 命令 | 作用 |
|---|---|
| `outbrief-daemon login` / `pair` | 创建账号或用配对码加入 / 显示二维码和配对码加新设备（见「配对」） |
| `outbrief-daemon install` / `uninstall` | 写入 / 删除 Claude Code、Codex 的 Stop hook 和 launchd 常驻配置 |
| `outbrief-daemon brief-eval <汇报文件…>` | 用 App 里设的大模型（`daemon.json` 的 `llm`）直接给汇报文件生成简报（不发给 server），打印 critical 覆盖率、口播字数比等指标；有 critical 事实没讲到或口播超过 60 % 时退出码 1 |
| `pnpm lint` / `pnpm format` | Biome 检查 / 自动修复 |
| `pnpm typecheck` | `tsc` |
| `pnpm test` | Vitest |

## License

[OutBrief License](LICENSE)（基于 Apache License 2.0 并附加条件，参照 [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)）。
