# assets/harness — 出处与许可

每个 harness 一个 16×16 的 SVG,按读取侧 id 命名(1.2 §agent chip 与图标)。它们由 trocar 自绘:形状 + 该 harness
的品牌色系,两两不同;既不是官方标志,也不是官方素材的描摹。自绘的图形在两套主题的 `--panel` 与 `--paper` 上
对比度 ≥ 3:1(由 `test/web-v2/harness-icons.test.mjs` 从 token 值计算)。加载走同源 fetch + 白名单检查
(`core/chips.mjs : sanitizeHarnessSvg`),不联网、不取第三方资源。

| 文件 | harness | 画的是什么 | 出处 |
|---|---|---|---|
| `cc.svg` | Claude Code | 圆角方框里的四芒星火 | trocar 自绘 |
| `codex.svg` | Codex | 六边形轮廓加中点 | trocar 自绘 |
| `opencode.svg` | OpenCode | 一对尖括号 `〈 〉` 加斜杠(代码) | trocar 自绘 |
| `kimi.svg` | Kimi Code | 一弯新月加一颗星 | trocar 自绘 |
| `dsh.svg` | DeepSeek dsh | 一头鲸加喷出的水气 | trocar 自绘 |
| `hermes.svg` | Hermes | 一架纸飞机 | trocar 自绘 |
| `zcode.svg` | Z-Code | 一道写成 Z 字的折线 | trocar 自绘 |
| `pi.svg` | pi | 希腊字母 π:一道彩色横梁下两条腿,右腿收尾上勾 | trocar 自绘 |
| `deepseek-cli.svg` | DeepSeek CLI | 终端窗格与提示符(旧采集认出的) | trocar 自绘 |

「未识别的 agent」的虚线方框图形不是文件,常驻在 `core/chips.mjs` 里(`UNKNOWN_ICON`),任何 harness 都不用它。

> 许可备注:若日后想换成各 harness 的官方标志,先做许可核对;不能再分发的,保留这里的自绘图形
> (1.2 §agent chip)。
