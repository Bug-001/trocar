# Harness icons

These are the agents' official icons, used only to identify each agent beside its name.
The registry that names each file is `src/off/harness-names.mjs`. The board build copies
this folder (without this file) into the board at `assets/harness/`.

The terms column says what allows redistribution, or that no stated terms were found and where we looked.
A code license (MIT, Apache-2.0) covers the file's copyright; it grants no trademark rights. A mark with
no stated terms is used as published, only to identify its agent (spec D76 ②). A mark whose terms forbid
redistribution, or whose owner asks for it to be removed, is replaced by a trocar drawing (spec 1.2 §agent chip).

| file | harness | source | retrieved | trademark owner | transformation | terms |
|---|---|---|---|---|---|---|
| claude-code.svg | Claude Code | https://claude.com/icon.svg (the site icon of https://claude.com/product/claude-code) | 2026-11-03 | Anthropic PBC | none (byte for byte) | no stated terms for this mark found; the Claude Code repository says "All rights reserved", use under Anthropic's Commercial Terms (https://github.com/anthropics/claude-code/blob/main/LICENSE.md); Anthropic's press kit (https://www.anthropic.com/press-kit, a 26 MB zip) was not read |
| codex.png | Codex | /Applications/ChatGPT.app/Contents/Resources/icon-codex-light.png (the ChatGPT desktop app, a public download from OpenAI); no public file URL for this mark found: the openai/codex repository and https://developers.openai.com/codex carry no Codex app icon | 2026-11-03 | OpenAI | `sips -Z 64` (1024 to 64 px) | no stated terms found: https://openai.com/brand/ answers a scripted fetch with HTTP 403; the openai/codex Apache-2.0 license does not cover this file |
| opencode.svg | OpenCode | https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/assets/favicon/favicon-v3.svg | 2026-11-03 | the OpenCode project (Anomaly) | none (byte for byte) | MIT, the repository license (https://github.com/anomalyco/opencode/blob/dev/LICENSE); the brand page https://opencode.ai/brand offers the assets for download with no usage terms stated |
| kimi-code.png | Kimi Code | https://raw.githubusercontent.com/MoonshotAI/kimi-code/main/docs/.vitepress/theme/Kimi.png | 2026-11-03 | Moonshot AI | `sips -Z 64` (316 to 64 px) | MIT, the repository license (https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE) |
| deepseek-dsh.svg | DeepSeek Harness (dsh) | https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/resources/icon-macos.svg | 2026-11-03 | DeepSeek | none (byte for byte) | MIT, the repository license (https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE); its BRAND_GUIDELINES.md says "DeepSeek Harness" is a registered trademark and asks that brand materials not be used to suggest endorsement |
| hermes.svg | Hermes Agent | https://github.com/NousResearch/hermes-agent/blob/main/website/static/img/favicon.svg | 2026-11-03 | Nous Research | none (byte for byte) | MIT, the repository license (https://github.com/NousResearch/hermes-agent/blob/main/LICENSE) |
| z-code.png | Z-Code | https://zcode.z.ai/favicon-192x192.png (the site icon of https://zcode.z.ai; the same mark as the ZCode.app icon) | 2026-11-03 | Zhipu AI (Z.ai) | `sips -Z 64` (192 to 64 px) | no stated terms for this mark found; the site's terms of service (https://zcode.z.ai/cn/terms) forbid taking the site's text and images by scraping or deep linking and grant no logo license |
| pi.svg | pi | https://pi.dev/logo.svg (press kit primary logo) | 2026-11-03 | Earendil Inc. | none (byte for byte) | the press kit (https://pi.dev/press-kit) offers the logo for download, says to use its visuals in articles, videos and slides, and is marked MIT License |
| deepseek-cli.svg | DeepSeek CLI (pre-D37) | trocar 自绘: this old CLI has no traceable official icon | 2026-11-03 | none (trocar's own drawing) | `stroke="currentColor"` changed to `stroke="#8a8f98"` (an `<img>` does not inherit `color`) | trocar's own drawing |
