# outbrief-daemon

[English](README.en.md)

每台用户电脑上的 OutBrief 常驻进程：接收 Claude Code / Codex 的完成回调和 Multica 任务汇报，用本机配置的大模型生成简报，加密后交给 outbrief-server 来电；挂断后在本机把回复送回原会话或 Multica 评论。

使用文档、安装步骤和架构决策都在官网：**<https://outbriefapp.com>**

- [Daemon 文档（安装、配对、简报、hook、本机接口）](https://outbriefapp.com/docs/daemon/)
- [快速开始（安装顺序与设备配对）](https://outbriefapp.com/docs/quick-start/)

## License

[OutBrief License](LICENSE)（基于 Apache License 2.0 并附加条件，参照 [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)）。
