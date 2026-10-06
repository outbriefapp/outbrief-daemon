# 给 Agent 的规则

## 自测不能给用户打电话

这台电脑上正在运行的 daemon（`127.0.0.1:8790`）和 server（`localhost:8787`）是用户本人在用的环境：任何一条进了 daemon 发件箱或 server 的汇报，都会马上变成用户手机上的一通来电。Agent 任务还没结束时发的测试汇报，会让用户先接到一通“假电话”，等任务真正结束（汇报评论写进 Multica）后再接一通（YOUT-201）。

- 不要向运行中的 daemon `POST /report`，也不要在 Multica 任务里用 `env -u MULTICA_TASK_ID …` 之类的办法绕过 hook 的 Multica 判断去调 `outbrief-daemon hook`。
- 不要直接向运行中的 server 发 `/v1/events`、`/v1/daemon/events`、`/v1/daemon/multica-reports`。
- 要验证：
  - hook 解析：`echo '<Stop payload>' | env -u MULTICA_TASK_ID -u MULTICA_ISSUE_ID node src/cli.ts hook claude-code --dry-run`，只打印要上报的内容，不发请求。
  - daemon 收汇报：`POST http://127.0.0.1:8790/report?dryRun=1`（要带 `Content-Type: application/json`，不能带 `Origin`），只校验并原样返回，不入发件箱、不来电。
  - 简报质量：`node src/cli.ts brief-eval <汇报文件>`，只调大模型，不发给 server。
  - 确实要走到“来电”的整条链路：另起一套隔离环境（server 换端口、换数据库；daemon 用临时 `OUTBRIEF_HOME`、另一个 `localPort`，`serverUrl` 指向隔离 server），不要用用户正在用的那套。
- 需要用户亲自接电话验收时，在 Multica 评论里写清楚怎么触发，由用户自己触发。
