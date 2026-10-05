# asight · 研究基底 — agent harness 开发真实痛点(2026-07)

> **这是什么**:一次多角度研究(perf/cost · context · cache · debug/observability · harness-maintenance,5 路并行 + 综合)的结论快照,作为 **D17(OBSERVE 深化 · 取证楔子)** 与 [1.1](1.1-product-definition.md) 产品定义(job / 差异化 / 替代方案)的**证据基底**。原始工作流:`agent-harness-pain-research`(33 条痛点入库,context-eng 一路 StructuredOutput 失败未回,perf/cache/debug/maint 四路齐)。
> **为何在仓**:约定「不在上下文即不存在」——已锁方向的证据 MUST 落版本化文档,不只存聊天。
> **一句话 job-to-be-done**:*当我的 agent 行为 / 缓存 / 成本出错而 SDK 只回 200,让 debugger(人或 agent)审问一份**逐字忠实、跨 provider 的「线上真相」**——它到底发给模型什么字节,从而定位线级缺陷(哪个字节断了 cache 前缀、哪一步撑爆了上下文、哪个字段偏离了 provider 方言),而**无须给 harness 插桩或改码**。*

## 痛点排序(severity × 多少人受 × 现有工具多失败)

| # | 痛点(线级不可见) | 谁 | asight 能力 | 现有工具为何不够 |
|---|---|---|---|---|
| 1 | **拿不到 harness 真正发出的字节**;且**无法观测非自己写的 harness**(闭源 CC/Cursor/Codex 直接掉进裸 mitmproxy) | agent-app 开发者、研究他人 harness 的工具人、安全审查 | observe | LangSmith/Langfuse/Phoenix/Weave/Helicone 都是**由内而外**(插桩你自己的码、内容采集默认关、记 SDK 逻辑重建、从不保证=线上字节);mitmproxy 有字节但零 agent/step/cache/replay 语义 |
| 2 | **cache 前缀被静默失效**(前缀里一个 timestamp/UUID、tool 数组乱序、>20 块的一轮把断点挤出窗、中途 compaction/retry、JSON key 乱序)——SDK 回 200、看得到**没命中**却永远不知道**哪个块/字节断了共享前缀** | harness 开发者、依赖 prompt cache 的 app、上下文工程师 | combination | Langfuse/Helicone 只**复述 provider 报的 cached-token 计数**,从不 byte-diff 请求 N vs N-1 去点名首个分叉块。**这是最密簇(~7/33)、最锋利的楔子** |
| 3 | **usage/cache 计费跨 provider 语义不兼容**(Anthropic cache_creation/read 计费 · OpenAI cached_tokens 免写 · Gemini 存储计费 · DeepSeek hit/miss · Bedrock inputTokens **排除** cache)→ 2+ provider 的队伍一个公式算不出命中率/真成本,悄悄算错 | 跨 provider app、gateway/平台、FinOps | observe | 各家把 provider 专属字段焊进 ingestion 且随新字段漂移;**无中立可审计的归一化 cache 模型** |
| 4 | **成本超线性涨**(每轮重发全部上文)却**无法归因到某一步/tool_result/文件读**——harness 只给一个聚合 token 计数 | agent-app、harness 开发者、长会话终端用户 | observe | 聚合面板给美元总数;无人给**逐步上下文增长曲线 + 块级归因**。诚实上限:asight 指出元凶(诊断),裁剪归 harness |
| 5 | **tool/MCP schema 税**:每个请求在任何 user 消息前就吃掉大片窗口(GitHub MCP 单个 ~42K;三个 server 吃 143K/200K=**72%**),抬 cost/TTFT、降选工具准确度,常规输出里不可见 | 接 MCP 的 app、内置大工具集的 harness | observe | 无工具给**每请求 tool-schema vs system vs history vs task 的字节/token 拆分**;asight 按 provider 固定序(tools→system→messages)归因每段权重 |
| 6 | **「OpenAI 兼容」只在文档兼容**(max_tokens vs max_completion_tokens、多出的 reasoning_content、被拒的 extra_body、/responses 404、tool_call+streaming bug;单厂两套线格式 Responses vs Chat)——过类型检查、回 200,直到线上 400 | framework/gateway 开发者、接第 2/3 家的队伍 | combination | 兼容是散文断言、从不对真实字节验证;asight 的跨 provider 原始字节语料 = auto-diff 新端点 vs 基线的地面真相。诚实边界:self-evolution 限于线格式/往返/usage 归一,不管 header 生命周期、不跑 eval |
| 7 | **不透明 reasoning/thinking 块须逐字往返**但每家规则不同、错了硬 400 或静默丢上下文(Anthropic signature 逐字重发 · DeepSeek reasoning_content 只在 tool loop 内回放 · OpenAI encrypted_content/previous_response_id——常互为反面) | 维护多轮 tool loop + transcript 序列化/回放层的开发者 | combination | 无工具验证 N+1 轮回发的不透明字段是否**逐字匹配** N 轮 provider 返回的;asight 两份都存 → debugger-agent 可断言「signature 逐字保留 / reasoning_content 正确(未)回放」 |
| 8 | **「replay」在现有工具里=重调 LIVE 模型**(非确定、烧 token、要活 key、可能改状态)→ 无法离线忠实复现旧故障;且**无一等公民的两 run 逐步结构 diff** | 复现间歇故障 / 回归 / 非确定性排查的人 | combination | Phoenix/LangSmith 的 replay 重调模型;比对是 metric/eval 中心非字节级。asight 的 replay = 对**存储原始字节**的确定性离线零 token 回放 + 时间旅行 scrub+diff |
| 9 | **唯一 cache 信号是 provider 自报 usage,且被观测到与现实矛盾**(SHA256 验证完全相同的前缀却 cached_tokens=0)→ 无从判断是自己前缀漂移还是 provider 误缓存/误计费 | 成本敏感 app、平台/FinOps 报 provider ticket | observe | 逐字捕获出站字节是**独立地面真相**,插桩工具结构性没有。**最强护城河但最低频**(不可能不靠线捕获复制) |
| 10 | **多 provider/harness 碎片 + 适配滞后**:~40 框架清单外要手写插桩、刚出的 provider/harness 让你盲数周、被迫换模型静默改行为(仍 200、工具仍触发)且无现成回归语料 | 混合队伍、采纳新 harness 的 infra、钉快照的上下文工程师 | self-evolution | 无工具**从原始流量自动派生**未见 provider 的 adapter;归一化静默丢 provider 专属字段。asight 的 self-evolution + 逐字生产 trace 当回归语料 = 真空白。诚实边界:asight 捕/放/diff 字节,不 SCORE eval |

## 结论(驱动的决策)

- **地形空白(landscape gap)**:**逐字线上真相层 · 由外而内(不改码)· 落进归一化跨 provider 模型**。所有 incumbent 由内而外、记 SDK 逻辑重建、内容采集默认关、从不承诺「面板=线上字节」;唯一见真字节的(mitmproxy)零 agent/step/cache/replay 语义。**asight 独占这个交叉点。**
- **方向(→ D17)**:**领跑 OBSERVE**——逐字透明捕获喂 **cache 前缀分叉定位视图** + 逐步上下文增长/schema-税归因。证据一边倒:ubiquitous、high-severity、被现有工具服务最差的痛(排名 1-5)全是**诊断/观测**痛;cache 簇独占 ~7/33、共享一个「provider 报计数从不报原因」的根,无人触碰。**确认(非推翻)既有 D2**(行为回放骨 + cache 叠加)。
- **二次序**:read-only **debugger-interface**(能力 A · query/MCP/SDK,让 agent 自动点名断裂)= 紧随其后的下游单元(薄层,在同一 trace 上),**先于 self-evolution、远先于 active-intervention**。
- **self-evolution 降级**:排名 ~10,真但「common」非头部楔子;harness-maintenance 痛反而更**支持 observe**(那些 bug 回 200、过类型检查,恰在别人操作的那层不可见)。作**后续单元**,非本轮 lead。
- **active-intervention(「agent 界 burpsuite」)确认保留**:证据最弱——真空白但需求 niche(反事实 debugger + red-team),且是唯一被 OBSERVE-only 不变式(D16)挡住的。**别让炫点领跑**;留独立下游 build-RFC + 消费者授权门(承 [5.1](5.1-intervention.md))。

> 覆盖缺口(诚实标):context-engineering 一路研究失败未回,"为何 agent 忘/循环/重读"欠采样(上下文增长/compaction 痛经 perf 路覆盖了部分)。需要时可补跑该路。
