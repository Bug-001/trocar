# asight · RFC 00 — 入口 / 总览

> **这是什么**:asight 产品 RFC 的入口与目录。装:顶部意图(A1)· 已锁决策追踪 · 模块地图 · 对齐闸(A3)· Non-Goals · 术语。各模块细节在同目录单元文件。
> **受众**:人(读意图与决策、据以决策)+ agent(据模块地图与对齐闸执行)。
> **不含 → 去哪查**:产品定义正文 → [1.1](1.1-product-definition.md);各模块设计 → 对应单元文件。

---

## 顶部意图(A1)

给「造 agent 基建的人」一台**透明示波器**:把任意 agent 应用真正发给大模型的**每一比特**(完整上下文 + 流式回复 + usage)按步回放、逐层拆解,让你——

- **意图① 看懂 agent 的行为**:这一步到底往上下文加了什么、为什么这么决策。
- **意图② 看懂它的上下文与缓存工程**:上下文怎么拼、缓存命中在哪断、什么随每步变化。

个人研究仪器优先深度洞察;架构按「采集 / 存储 / 分析 / 前端 / harness 适配」解耦,为日后产品化留缝。全套产品叙事见 [1.1](1.1-product-definition.md)。

---

## 已锁决策追踪(单一权威 · 任何改动 MUST 写回本表)

| # | 决策 | 选定 | 备选(未选) | 理由 |
|---|---|---|---|---|
| D1 | 定位 / 受众 | 个人研究仪器 + 产品化留缝 | 纯个人 / 直接做产品 | 深度洞察优先,又不堵死产品化 |
| D2 | 中央看板主线 | **行为回放为骨 · cache 为叠加层** | cache 为主 / 两条并列可切换 | 一条主线承载两目的,首页不撕裂 |
| D3 | v1 harness 范围 | **3 个跨 provider**:CC / Anthropic;Codex / OpenAI(经本地 relay);DeepSeek-CLI / DeepSeek | 只 CC / 只同 provider ×2 | 跨 provider 才真验证适配层;三家 cache 设计各异,正服务意图② |
| D4 | 采集 | **可插拔采集源**:MITM / base_url 反代 / relay-tee | MITM 一切 / 反代一切 | CC-Desktop 只能 MITM、Codex 已有 relay、DeepSeek 听 base_url;每 harness 选最便宜源 |
| D5 | 存储 / 管道 | **NDJSON 源 → ETL → DuckDB/Parquet + SQL** | 敏捷解析缓存 / OTel+ClickHouse 栈 | 跨 session 分析查询 + 增量;通用 obs 栈渲染不了招牌视图 |
| D6 | 前端渲染 | **自建 app**,借 Perfetto/时间旅行/LLM-obs 语法;轻框架 + 虚拟化 + DuckDB | 整套 Perfetto / vanilla 手搓 | 招牌视图须自建;轻框架撑多面板高吞吐 |
| D7 | 自演化工作流 | **单独立项**(下游 RFC) | 写进本 RFC | 是"怎么开发本产品"的元流程,依赖本 RFC 的适配契约 + 验收标准 |
| D8 | schema 粒度 vs UI 分组 | **schema 存 provider-中立细粒度**(resource `kind` 含 `scaffold`、`calls.lane` 到 `aux`);分组(2.4 六组)/ 子类文案(aux→notify/titlegen/quota)是**渲染期投影**;only-seen 名字 = `event='seen'`(metadata) | 加 `capability` 伞 kind / 加 CC lane 子类 / only-seen 只在部件本地派生 | 中心契约保通用,harness 专属聚合留在渲染层——不污染 schema、不破适配缝(3.1/3.2/2.4/2.6) |
| D9 | 控制面(session-less 底噪)归宿 | **`calls.class='control'` + `session_id NULL` + `control_calls` 投影**;adapter 出归一化 `control_kind`;`sessions` 保持纯会话 | 合成 `sessions.kind='control'` 伪会话 / 全表 nullable | 最真实、不发明伪会话、不误导;NULL 只局限控制面查询(3.2/3.4/3.1/2.6) |
| D10 | 采集↔适配统一信封 | **canonical 定义单一权威在 [4.1](4.1-capture-sources.md) §统一原始信封**(3.1 命名 + 观测元数据字段),3.1/4.2 引同一定义 | demo 的 `request_headers/request/response` 命名 / 两处各定义 | 接缝单源、避免两处定义漂移(不变式 3 在采集端的兑现) |
| D11 | 查询传输 | **服务端 HTTP 返 JSON(A)** for v1:查询在服务端跑 SQL+分页,浏览器只取所需页/单 call | 浏览器内 DuckDB-Wasm(B) | 单机个人仪器最简、零浏览器依赖;大 trace 留服务端(正避开 800MB-入-tab 问题);(B) 记为 Extension,契约保持传输无关(同形结果集)(3.5/4.4/4.3) |
| D12 | 上下文窗口折叠记忆 | **按 turn-anchor `content_hash` 记忆折叠态**(持久 localStorage):跨 scrub 存活、compaction 自然重置(新 turn=新 hash);未触碰 turn 默认末轮展开;+ 全展/全折便捷 | reset-on-scrub(无记忆)/ 粗粒度 sticky view mode | 复用既有 dedup/cache-break 键(3.2 `content_hash`),跨步稳定、不靠易漂移的 turn 索引(1.4/2.2/2.3) |
| D13 | 时间轴导航(overview+detail brush) | **概览条 + brush 视口**:排轴下一条全-session 概览条(step 少=每 call 柱、多=降采样 streamline,标「采样显示」)+ 半透明 brush(拖体=平移、拖边=缩放);detail 排轴只渲 brush 内 call、`xOf` 对 brush 窗重标定,**所有轨+cache 带+ticks 同轴锁步**;playhead 与 brush 同步 | min-width+横滚 / 纯 Extension zoom | 经典 focus+context 交互一举给缩放+平移,救大 session 导航且不撕裂 /N 对齐(1.3/2.1) |
| D14 | 单价 / 花费 | **单价 = 可编辑配置**(provider 只回 token usage,无 $ 单价);cost = `usage × 单价` 派生,**MUST NOT 入归一化模型** | 单价烤进查询视图(改价=改码)/ 存 cost 进表 | 单价是外部可变量、用户可编辑;cost 是本地估算非源真相(2.2/4.4) |
| D15 | tools 保真度 | **采集逐字存 tools schema**(关掉 demo `summarizeRequest` 的元数据降解,摘要上移 adapter);tools **纳入 AC-1 逐字**,不再 metadata 例外 | 保持 tools = 元数据(AC-1 排除) | 中央看板须忠实呈现原上下文(D-永久不变式);tools schema 是模型真实所见的一部分(4.1/4.2/3.2) |

### 待数据决策(deferred-until-capture · 非 v1 阻塞)
以下三项**须先有真实抓包 / harness 接入才能定**,现记为**显式延迟(带触发条件)**——非悬空 OPEN:
- **R · CC `/rewind` 线上表现**([3.4](3.4-session-identity.md)):开发者 rewind 在 wire 如何呈现(疑似 message_count 骤降)→ 待一次真实 `/rewind` 抓包确认后补判定。
- **DS · DeepSeek 合成 session 键 + `reasoning_content` 解析**([3.1](3.1-adapter-contract.md)/[3.4](3.4-session-identity.md)):DeepSeek 无 session id、reasoning 为字符串 → 合成键启发式与解析**先对真实 DeepSeek 抓包核对再硬编码**(现仅 CC 有数据)。
- **X · Codex relay-tee 机制**([4.1](4.1-capture-sources.md)):在 Codex 既有本地 relay 加 tee 吐同信封的落地细节 → 待接入 Codex relay 时定;落地前 Codex 采集不完整,UI 须标注。
> 触发即解:对应 harness / 功能首次被真实采集时,补判定并写回决策表。

> 三家 provider 的 cache 设计(D3 的技术后果,直接喂意图②):Anthropic = 显式 `cache_control` 断点(tools→system→messages 前缀、TTL);OpenAI(Codex)= 自动前缀缓存(`cached_tokens`、1024-tok 起);DeepSeek = 自动磁盘缓存(`prompt_cache_hit/miss_tokens`)。cache 抽象(3.3)MUST 能表达这三种。

---

## 模块地图

四模块(结构遵循本仓采用的 RFC 撰写规范):**1.x** 产品定义→UI/UX(人主决策)· **2.x** 界面部件(人+agent)· **3.x** 业务逻辑(人主决策)· **4.x** 底层(agent 主决策)。**一逻辑单元一文件**;单元文件在**设计到该单元时落盘**(§4「边定边写」),非一次性建空壳。★ = 招牌 / 心脏模块。

| 文件 | 逻辑单元 | 状态 |
|---|---|---|
| [1.1-product-definition](1.1-product-definition.md) | 产品定义叙事(§3.1 A 全套) | **已成文** |
| [1.2-shell-layout](1.2-shell-layout.md) | 外壳:左右页 · 可调边界 · 顶栏(agent/path/session + fork/分支怎么显示) | **已成文** |
| [1.3-timeline-tracks](1.3-timeline-tracks.md) | 排轴:context 柱(多色=类型)· 左对齐轨道标题 · 勾选叠加轨 | **已成文** |
| [1.4-central-board](1.4-central-board.md) | 中央看板:忠实回放 · 按步 scrub · 勾选轨→额外事件(如安全监测) | **已成文** |
| [1.5-states-aesthetics](1.5-states-aesthetics.md) | 关键状态(空/超长/多 harness)+ 审美维度(明暗双态·排版·招牌视觉) | **已成文** |
| [2.1-track-widget](2.1-track-widget.md) | 轨道部件(柱/tick/缩放/hover/click→定位 card) | **已成文** |
| [2.2-call-turn-card](2.2-call-turn-card.md) | call-turn card(时间/模型/token/花费/cache · 折叠原位展开) | **已成文** |
| ★ [2.3-context-window](2.3-context-window.md) | 忠实上下文回放部件(承 demo v11 单窗口,泛化到跨 provider) | **已成文** |
| [2.4-resource-explorer](2.4-resource-explorer.md) | 资源管理器(文件/MCP/skill/plugin/tool 进出 + 生命周期) | **已成文** |
| [2.5-outline-nav](2.5-outline-nav.md) | 左栏 outline 导航 | **已成文** |
| [2.6-detail-panel](2.6-detail-panel.md) | 右下可关闭 panel(原始数据流)+ 非核心流侧栏 | **已成文** |
| ★★ [3.1-adapter-contract](3.1-adapter-contract.md) | 适配层契约(provider 线格式 × harness 约定 → 归一化)——**产品的心脏** | **已成文** |
| ★★ [3.2-normalized-model](3.2-normalized-model.md) | 归一化 schema(sessions/calls/blocks/resources/cache_events) | **已成文** |
| ★ [3.3-cache-model](3.3-cache-model.md) | cache 抽象:统一命中/断点/前缀复用,能表达三家 cache 设计,用真实 usage | **已成文** |
| [3.4-session-identity](3.4-session-identity.md) | session / fork / 分支识别(顶栏同名 session 问题的权威) | **已成文** |
| [3.5-query-layer](3.5-query-layer.md) | 前端 ↔ DuckDB 查询契约 | **已成文** |
| [4.1-capture-sources](4.1-capture-sources.md) | 可插拔采集源 + onboard/证书/代理配置 + 测试(Codex relay-tee 细节 TODO) | **已成文** |
| [4.2-storage-etl](4.2-storage-etl.md) | NDJSON → ETL → DuckDB/Parquet + 增量 | **已成文** |
| [4.3-parse-index-cache](4.3-parse-index-cache.md) | 解析/索引/缓存(治反复解析卡顿) | **已成文** |
| [4.4-server](4.4-server.md) | 本地服务(serve 前端 + DuckDB 查询 API vs DuckDB-Wasm 决策) | **已成文** |

---

## 对齐闸(A3 · 进实现前人核对)

进实现前,MUST 在 `confirm` 卡点由人核对本闸;**闸不过不进实现**。

| 顶部意图 | 由哪些模块兑现 | 验收如何证明 |
|---|---|---|
| ① 看懂 agent 行为 | 1.4 + 2.2 + 2.3 | 对真实 CC / Codex / DeepSeek session,逐字回放每步完整上下文 + 回复,**与线上 bytes 一致(可 diff)** |
| ② 看懂 cache / 上下文工程 | 1.3 + 3.3 + 2.4 | cache 叠加显示的命中/断点**与该步 response 真实 usage 一致**;三家不同 cache 设计都能表达 |
| 跨切:适配层通用 | 3.1 + 3.2 + 4.1 / 4.2 | 加第二 / 三个适配器,**不改前端主干**即点亮面板 |

---

## Non-Goals(全局 · 越界即自我否决)

- 流量注入 / 改写(v1 仅观测);永不用被测 token 发起请求。
- 多用户 / 账号 / 云端分享。
- 面板自演化工作流(D7,单独立项)。
- 把整机系统代理路由进 MITM。
- 实时告警 / 生产监控(这是研究仪器,非运维监控)。

---

## 术语速查

- **harness**:一个 agent 应用(CC / Codex / DeepSeek-CLI)。
- **provider**:模型 API 提供方(Anthropic / OpenAI / DeepSeek),线格式与 cache/usage 字段各异。
- **session**:某 harness 一次任务的全部上下文流——asight 的**核心对象**。
- **归一化模型**:三 provider 忠实落进的统一表(见 3.2)。
- **采集源**:拿到字节的机制(MITM / base_url 反代 / relay-tee,见 4.1)。
- **逐字忠实 vs 元数据**:原始 bytes 逐字存 = 忠实;只存名字/大小/计数 = 元数据。保真边界 UI 必标(见上「核心不变式」第 4 条)。
