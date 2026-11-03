# Harness icons

These are the agents' official icons, used only to identify each agent beside its name.
The registry that names each file is `src/off/harness-names.mjs`. The board build copies
this folder (without this file) into the board at `assets/harness/`.

| file | harness | source | retrieved | trademark owner | transformation |
|---|---|---|---|---|---|
| claude-code.svg | Claude Code | ~/.vscode/extensions/anthropic.claude-code-2.1.314-darwin-arm64/resources/claude-logo.svg | 2026-11-03 | Anthropic PBC | none (byte for byte) |
| codex.png | Codex | /Applications/ChatGPT.app/Contents/Resources/icon-codex-light.png | 2026-11-03 | OpenAI | `sips -Z 64` (1024 to 64 px) |
| opencode.svg | OpenCode | https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/assets/favicon/favicon-v3.svg | 2026-11-03 | the OpenCode project (Anomaly) | none (byte for byte) |
| kimi-code.png | Kimi Code | https://raw.githubusercontent.com/MoonshotAI/kimi-code/main/docs/.vitepress/theme/Kimi.png | 2026-11-03 | Moonshot AI | `sips -Z 64` (316 to 64 px) |
| deepseek-dsh.svg | DeepSeek Harness (dsh) | https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/resources/icon-macos.svg | 2026-11-03 | DeepSeek | none (byte for byte) |
| hermes.svg | Hermes Agent | https://github.com/NousResearch/hermes-agent/blob/main/website/static/img/favicon.svg | 2026-11-03 | Nous Research | none (byte for byte) |
| z-code.png | Z-Code | /Applications/ZCode.app/Contents/Resources/icon.png | 2026-11-03 | Zhipu AI (Z.ai) | `sips -Z 64` (1024 to 64 px) |
| pi.svg | pi | https://pi.dev/logo.svg (press kit primary logo) | 2026-11-03 | Earendil Inc. | none (byte for byte) |
| deepseek-cli.svg | DeepSeek CLI (pre-D37) | trocar 自绘: this old CLI has no traceable official icon | 2026-11-03 | none (trocar's own drawing) | `stroke="currentColor"` changed to `stroke="#8a8f98"` (an `<img>` does not inherit `color`) |
