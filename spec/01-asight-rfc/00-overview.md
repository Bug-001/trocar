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
| D16 | OBSERVE-only 模式化(为主动模式预留) | **不变式 1 从绝对律 → 模式边界**:**观测模式**(默认 · v1 全部 · 唯一已建)恒 OBSERVE-only(永不 originate/注入/改写/用被测 token),模式内违反 = **必拒**;**主动模式**(intercept/modify/inject/relay + auto-adapt)是**独立 · 显式 · 消费者授权 · 非默认 · 未 v1** 的第二形态,MUST 走专门下游 build-RFC 才落地(见 [5.1](5.1-active-mode-reserved.md)),落地前主动发请求/改包仍 = **必拒**;观测模式纯粹性 MUST NOT 被主动模式污染(独立源类型 + 独立服务/模式 + 消费者授权门) | 保绝对律(active 另立独立产品)/ 仅留 vision note 不动不变式 | asight「另一面」=直接反哺 agent 开发(auto-adapt + agent 界 burpsuite);模式边界让未来可能而今不破 today(承 [1.1](1.1-product-definition.md):65) |
| D17 | OBSERVE 深化(取证楔子 · 研究驱动) | 把 v1 观测深化到 harness 开发的**头部真实痛点**([研究基底](research-2026-07-harness-pain.md)):① **cache 前缀分叉定位**——byte-diff 请求 N vs N-1、**点名首个断了共享前缀的块/字节 + 为何**(不止复述 provider 的 cached 计数);② **逐步上下文增长 + schema-税归因**——每步 tools/system/history/task 的字节/token 权重、哪一步/块撑爆重发前缀;③ ~~**跨-run 逐步结构 diff**——两条 run 的确定性离线字节级比对(非重调模型)~~ **【已撤 · 曾落地的 `compareView`/`/api/compare`/`src/web/compare.html` 已移除。①②④⑤ 保留(皆同-session 取证,非跨 session)。3.5 的跨-session 聚合*分析*(非成对 compare)另议】**;④ **地面真相验证**——证明出站前缀逐字一致 vs provider 误缓存/误计费;⑤ **不透明 reasoning 往返校验**——N+1 轮回发的 signature/reasoning_content 是否逐字匹配 N 轮返回。**领跑 OBSERVE、确认 D2**;贯穿 1.3/1.4/2.2/2.3/3.1/3.2/3.3/3.5 | 让 v1 停在「能看」不深化 / 先做 self-evolution(研究排 ~10)/ 先做 active-intervention(研究最弱 + D16 挡) | 研究证据一边倒:ubiquitous·high-severity·被现有工具服务最差的痛全是诊断/观测痛,cache 簇独占 ~7/33 且根「报计数不报原因」无人触碰;这是 asight 独占的线上真相层的兑现 |
| D18 | 技术栈(D5/D6/D11 落地) | **前端 = 轻框架(承 D6)+ 虚拟化**(**D18a:整段复用 demo `index.html` 的渲染/交互/CSS 层作为产品前端**(从零重建部件实测**远离 demo 观感,已否决**)——删掉 demo 浏览器内 `analyze()`,数据改由产品**服务端 canonical**([3.5](3.5-query-layer.md) query 层)经 **view-assembler** 供给,provider 解析/适配**全留服务端** → **不变式 3 / AC-3 守住**;把 D6「轻框架」读作「轻量」。**落地事实**:复用的 `src/web/index.html` **自包含**(inline CSS/JS,**零 bundler / 无 esbuild / 无 `dist/`** → 直接 static-serve,亦即 npm `files` 直接带走);服务端 view-assembler = `src/view/{analyze,assemble,board}.mjs`(`analyze()` 跑服务端,per-call 烤 `flat`/`cacheBreak`(含 `gt`)/`norm`);canonical 走 `/api/{projects,session,control}`(源 = 原始 NDJSON,承不变式 2);**JSON 传输丢失的 Map**(`analyze` 的 `giLocal`)在客户端 `buildLanes` 由 canonical 数组重建(纯派生索引、无 provider 逻辑);**usage 叠加读中立 canonical 名**(board 代码里**零 provider-native usage 名**——服务端 view-assembler 烤 `call.usage = {read, create, fresh, out}`,承 [3.2](3.2-normalized-model.md) usage 列 `cache_read/cache_write/input_uncached/output`;前端 6 处 usage 站点读中立名 → 兑现 Goal「前端永不出现 `cache_read_input_tokens`」+ server.test no-leak grep 一致;加 harness = 服务端 normResp 映射进同一中立 schema,前端不动,AC-3);verbatim 请求随回放载荷传输 = **源真相**(不变式 2),非适配缝泄漏(**2026-07-16 修**:v0 记录 = `rec.request` 解析对象;**产品 D10 capture = 逐字 `req_body` 串**,board 经 CC dissector 的 board-intake `hydrateForBoard` 解析成 blocks,承 **D25**——原「rec.request 对象」措辞是 v0-专属,D10 的源真相更是逐字 wire 串);**agentChip 表驱动**(`meta.harness` → 前端 CHIP 表,非硬编码);render gate = `test/web/dashboard-render.mjs`(headless DOM shim 喂**冻结 canonical**,断言各面板 + AC-1 逐字)。原倾向 **Svelte** 已弃(复用 demo 逻辑 > 重写));**DuckDB 访问 = Node 官方 `@duckdb/node-api`**(服务端跑 SQL,承 D11-A);**语言/工具 = JS(`.mjs`)+ `node:test`(前端自包含 → 无打包器)**(承 demo 零依赖基线);**后端 = Node 零依赖 `node:http`**(承 [4.4](4.4-server.md)) | vanilla 手搓(复用最多但违 D6 字面)/ DuckDB CLI 子进程 / duckdb-wasm(= D11 的 B,留 Extension)/ TS 全栈 + vitest | D5/D6/D11 定了栈的**形状**(DuckDB + 轻框架 + 服务端 SQL)却未**点名**;本行钉死具体选型 = 代码级 dev-doc 的前置闸。 前端遵 D6 轻框架(vanilla UI 逻辑复用、按框架重写)、DuckDB 官方 Node 绑定(与 4.4 零依赖服务同栈);4.2/4.4/3.5 全部 gate 在此 |
| D19 | `content_hash` 字节精确 | **`content_hash` = 块「逐字序列化字节」(采集所见原始序列化,**非 key 规范化**)的全内容 sha-256**;它同时是 [3.2](3.2-normalized-model.md) 去重 PK 与 [3.3](3.3-cache-model.md) cache-break 分叉信号,两角色都 MUST 字节精确。`canonJSON`/键序规范化**仅**用于 [3.3](3.3-cache-model.md) `divergence_cause` 分类(判 json-key-reorder/tool-array-reorder 是不是你的锅),**绝不**用于 hash;demo 的 32-bit / 前 4096 字符 hash **必换**全内容 sha-256 | key 规范化后 hash(会把 key-reorder 类 cache-break 塌进去重、变不可见)/ 保留 demo bounded-prefix(碰撞丢块,**必拒**) | 消解 [3.1](3.1-adapter-contract.md):26 / [4.2](4.2-storage-etl.md):46「over 块 canonical bytes」措辞歧义(若「canonical」误读为 key 排序,则最锋利的 reorder cache-break 不可见)。demo 已证正确设计(byte-exact key + canonJSON 只分类);本行确认字节精确并收紧 3.1/4.2 措辞(3.1/3.2/3.3/4.2) |
| D20 | 采集↔ETL 分流归属 | **采集源 = 纯 tee,只写 append-only 统一信封流(按物理源分文件即可,不按 session 预分流)**;**session 归属 / 分流 / 血缘 = ETL([4.2](4.2-storage-etl.md))用 [3.4](3.4-session-identity.md) 线上信号做**。承 [4.1](4.1-capture-sources.md):66「per-session 路由是 4.2 的雏形、不在本层」+ [5.1](5.1-active-mode-reserved.md) 采集纯被动预留 | 采集侧分流(demo 现状 `atrace-mitm.mjs` 引 `sessions.mjs`)——耦合身份进采集、v0 shortcut | 消解 4.1:66(路由不在采集层)与 4.2:11(读预分流目录为源)的不一致。采集越薄越接近纯 tee → 身份判定不漏进采集端(不变式 3 在采集端兑现 + 为 5.1 主动源类型隔离留净边界);demo 采集侧分流降级为 v0 shortcut,产品移入 ETL(4.1/4.2/3.4) |
| D21 | 派生 memoization 落位(承 D11-A) | **[4.3](4.3-parse-index-cache.md) 的 `flat`/`comp` 派生记忆化 = 服务进程内、按 `call_id`(+ 渲染策略版本)键的 LRU**(cache-break 已下推 SQL/[3.5](3.5-query-layer.md),此处只剩 flat/comp)。无状态 HTTP 传输(D11-A)下记忆化是**服务端进程缓存**,非浏览器长驻宿主对象;miss 从 store/源重算(可重建 → 逐出无损),失效签名守正确 | 每 poll 重导(丢记忆化收益)/ per-connection 缓存(无状态传输下连接不长驻)/ 保留 demo 浏览器 SPA 宿主对象(与 D11-A 服务端 SQL 不符) | 消解 review 标的「demo 挂宿主对象假设长驻 SPA、但 D11-A 每 poll 全新请求无长驻对象」缺口。服务端按 call_id LRU 与 D11-A(服务端 SQL、浏览器只取页)同栈(4.2/4.3/3.5) |
| D22 | 跨平台采集 / onboard 可移植性(承 D4) | **onboard 的 OS-触碰部分抽成跨 OS `TrustStoreInstaller` 接口(`install`/`verifyUserTrustOnly`/`uninstall`),`process.platform` 分派,v1 落 **darwin + linux**(Windows 预留)。**采集安全#3 从 macOS 措辞泛化为平台中立原则**:采集 CA 仅 **import-only** 装进**用户级**信任库、**绝不全机弱化 TLS**;per-OS 机制 = 附录(mac `security add-certificates`·login keychain;linux `certutil -d sql:~/.pki/nssdb -A`·用户 NSS 库;win 预留 CurrentUser store)。**steer**:`base_url`/`HTTPS_PROXY` 反代路径本就跨平台(Linux 上今天即端到端);Clash steer 降为 **macOS-Desktop 专属实现之一**,非跨平台契约。**下游(D10 信封→adapter→DuckDB→server→前端)平台无关,一行不改** | 只 mac(堵死 Linux)/ 全机信任省事(违采集安全·必拒)/ MITM 一切(扩解密面·必拒) | 可移植性已被 D4 可插拔源 + 纯 Node 下游收进 onboard+steer 两条薄缝;泛化不变式守住「绝不全机弱化 TLS」的精神跨 OS 不破。 mac+linux 一起、补 spec(4.1/[4.5](4.5-distribution.md)) |
| D23 | 分发 / release 策略(承 D1「产品化留缝」) | **npm/npx 优先**(`npx asight` 起服务)+ **GitHub Release 挂 tarball**;**GH Actions 打 tag `v*` 触发**构建/发布。每个安装仍 **单机 · 单用户 · loopback · OBSERVE-only**——**不开多用户/云端**(不破 Non-Goal + 4.4 只绑环回)。`@duckdb/node-api` 各平台有 prebuilt,npm 自动选对 → npm-first 分发最干净。细节见新单元 [4.5](4.5-distribution.md) | 预编译单文件二进制(SEA)优先(DuckDB 原生 `.node` 打包 fiddly → 记为 [4.5](4.5-distribution.md) Extension)/ 不分发(违 D1 留缝) | Node CLI 分发最省、跨平台白送(Node 消化 OS 差异);D1「产品化留缝」在分发层的最小兑现,单机边界不越 Non-Goal。|
| D24 | board 数据源分期(承 D18a Option-2 + D11-A + [4.4](4.4-server.md):88) | **board per-session 回放数据源分期**:**v1(已建)= 服务端 view-assembler 跑 `analyze()` over **源 NDJSON**(源真相 · 全 fidelity · render gate 钉);DuckDB 供**跨 session SQL 族**([3.5](3.5-query-layer.md))。**board→DuckDB 投影迁移 = 后续**,双闸:**(i)** [4.4](4.4-server.md):88② 兑现——`src/query/source.mjs` resolver 改**惰性**(`recordId→文件字节偏移`索引 + per-request `fs.read(seek,span)`+slice),消除当前 `buildResolver` **全量载入每条 `req_body` 进 Map = O(N²) 常驻 RAM** 缺口(dodges 单串 512MB 上限但**非**聚合 RAM);~~**(ii)** [3.2](3.2-normalized-model.md) schema 扩展,存 response text / message-turn 边界 / 完整 tool-meta~~ **【(ii) 已撤 · 2026-07-16 → 见 D25:15-agent 对抗评审证「跨 3-provider 忠实建模 response 进中心 schema」= blocker(丢 thinking/reasoning、SSE 重建冒充 verbatim、per-adapter turn 判定漏进契约);改走语义无关 DB + dissector】**。迁移 **MUST 保 render gate(`test/web/dashboard-render.mjs`)绿**(fidelity 不回退)。**存储调研(2026-07-16)证 DuckDB 已实现「块去重 + 每步块索引 + 步间 diff」**:`block_contents.content_hash`(全局内容寻址去重 · insert-if-absent)+ `call_blocks`(每 call 有序 `content_hash`)+ `cache_events`(`structural_divergence_seq` = 相对上一步前缀断点)——即目标架构,已建非待建 | board 直接从 DuckDB 起步(需先 (i)+(ii),阻塞交付)/ 永不上 DuckDB(丢 4.4:88 大 session 内存治理 + 跨 session SQL)/ 浏览器内 `analyze()`(demo v0,违不变式 3) | 调研证 DuckDB 投影是**更优读成本架构**且大部件已建;render 完整性缺口的**解法由 D25 改写**(dissector 产 blocks、DB 语义无关),分页/D17④ 走轻路(源 NDJSON 服务端算)或 D25 之上。承 D18a / D11-A / 4.4:88 |
| D25 | dissector 模型 + 语义无关 DB(承 D24 复议 ) | **两条。① dissector 模型**:每个 (provider×harness) 一个 **JS-module dissector**(承 [3.1](3.1-adapter-contract.md) adapter 契约:原始 bytes → canonical **blocks** + 声明 block 分类/布局),**board 与 ETL 共用**——消解当前**双解析器**(board `analyze.linearContext` 只吃 v0 `request` 对象;ETL `cc.parseBlocks` 吃 D10 `req_body` 串 → **产品 D10 capture 在 board 渲成空**)。**block = 唯一跨-provider 统一单元**;provider 专属(response 形状 / turn 判定 / tool 抽取)全落 dissector,**不进共享 schema**。加 harness = 写一个小 dissector(JS module 即"小脚本",**非**嵌入式 DSL/Lua——省运行时依赖 + 沙箱面)。**② DB 语义无关**:DuckDB = **内容寻址持久块存**(`block_contents` content_hash→定位 + `call_blocks` 每 call 有序块索引)= 一个持久哈希表,**只存块、不建模 response/turn/tool 语义**。**step 1 已落地**:CC dissector 的 board-intake(`hydrateForBoard` · `src/view/assemble.mjs`)让 D10 capture 在 board 渲**逐字**(tools 带完整 `input_schema`、不再 metadata),v0 无变;`test/view/assemble-d10.test.mjs` 钉。**step 2 已落地(2026-07-16)**:单一 CC dissector 模块 `src/dissect/cc.mjs`(声明式 `CC_SECTIONS` + `dissectBlocks(req)` 装配序走查 + 共享 `resourceRef`/`isVolatile`/`blockKind`/`faithfulness`/`sysLabel`/`parseBashReads`);board `linearContext` 与 ETL `parseBlocks`(叠加 D19 字节 span)退成其**投影**,消解双解析器(`test/dissect/cc.test.mjs` 断言两投影 block-for-block 一致);见 [3.1](3.1-adapter-contract.md)。**Phase 4 · Codex dissector 已落地(2026-07-16)**:`src/dissect/openai.mjs`(同形 · Responses API → 同一 block 词表 · encrypted reasoning=opaque · usage 从 SSE 重建),board 零改动渲真实 `codex_exec`+gpt-5.5 抓包;采集经 asight `capture` tee → SSH 隧道 → bestony(mini-codex)。**剩** DeepSeek dissector(待 DeepSeek API)。 | 嵌入式 DSL(Lua/QuickJS:加运行时依赖 + 沙箱面,零依赖工具不值)/ 保留 D24(ii) 建模 response 进 schema(评审 NO-GO)/ 保持双解析器(D10 board 渲空,产品 capture 不可看) | 用户洞见 + 15-agent 对抗评审共识:schema 建模 response 是 provider-耦合死路,而 adapter 本就是 dissector([3.1]),此为其**形式化 + 完成**;DB 退成持久哈希表加速块查询即够。承 D18a/D24/[3.1](3.1-adapter-contract.md);spec patch 同 PR |

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
| [4.5-distribution](4.5-distribution.md) | 跨平台 onboard(`TrustStoreInstaller` per-OS)+ npm/npx & GH Release 分发(D22/D23) | **已成文** |
| [5.1-active-mode-reserved](5.1-active-mode-reserved.md) | asight 的另一面(预留):自动适配 + 主动干预(agent 界 burpsuite)· OBSERVE-only 模式边界(D16)· 预留架构缝 | **预留 · 非 v1**(须专门 build-RFC + 消费者授权才落地) |

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
