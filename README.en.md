# outbrief-daemon

[中文](README.md)

The resident OutBrief process on each user computer. It takes Claude Code / Codex stop hooks and Multica reports, writes the spoken brief with the LLM configured on that machine, and hands it to outbrief-server encrypted. After hang-up it delivers the reply to the same session or Multica comment.

Docs, install steps, and design decisions are on the website: **<https://outbriefapp.com/en/>**

Questions, feedback, and ideas: join us on [Discord](https://discord.gg/TG8qHzdv6).

- [Daemon docs (install, pairing, briefs, hooks)](https://outbriefapp.com/en/docs/daemon/)
- [Quick start (install order and pairing)](https://outbriefapp.com/en/docs/quick-start/)

## License

[OutBrief License](LICENSE) (Apache License 2.0 plus extra terms, following the [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)).
