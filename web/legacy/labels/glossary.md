# Board glossary

## 界面词表

看板的英文名词以本表为准:一个概念只用一个词,表与 `web/legacy/labels/**` 的字符串一一对应。标 (CLI) 的词由命令行定(`src/cli/words.mjs` · `status-text.mjs` · `src/off/harness-names.mjs`),是查表不是翻译,看板不另起措辞。「not used」是被否掉的拼法,`test/web-v2/english.test.mjs` 从本表读它们,看板代码的字符串里出现即红。harness 名与类别 id(`llm` `token-count` `session-sync` `telemetry` `files` `account` `other`)是数据,不进本表。

| concept | English | not used |
|---|---|---|
| 看板 | board | dashboard |
| 采集 | capture (CLI) | sniffing |
| 采集服务 | capture service | daemon |
| 采集文件 | capture files | trace files |
| 采集记录 | capture log | capture history |
| 采集失败 | capture failures (CLI) | capture errors |
| 采集状态 | capture health (CLI) | capture status |
| 段 / 段索引 | segment / segment index | shard |
| 封存 | sealed | archived |
| 会话 | session | conversation |
| 会话副本 | session copies | |
| 回放台 | replay | playback |
| 步 | step (CLI) | turn |
| 调用 | call | invocation |
| 模型调用 | model call | LLM call, LLM request |
| 流量 | traffic (CLI) | |
| 请求 / 响应 | request / response | |
| 请求头 / 响应头 | request headers / response headers | |
| 请求体 / 响应体 | request body / response body | payload |
| 线上 | wire | on the network |
| 原始数据 | raw | raw data |
| 上下文 | context | prompt history |
| 上下文窗 | context window | |
| 对话 | messages | chat history |
| 系统提示 | system prompt | system message |
| 工具定义 | tool definitions | tool schemas |
| 工具调用 / 工具结果 | tool call / tool result | function call |
| 思考 | thinking | |
| 块 | block | chunk |
| 资源 | resources | |
| 读过的文件 | files read | |
| 子 agent | sub-agent | child agent |
| 最后活动 | last active | |
| 组名:今天 / 昨天 / 没有时间 | today / yesterday / no time | |
| 后台调用 | background calls | |
| 主对话 | main thread | main conversation |
| 缓存 | cache (CLI) | |
| 缓存命中 | cache hit | cache rate |
| 缓存断开 | cache break | cache bust, cache miss |
| 缓存标记 | cache mark | cache breakpoint |
| 读缓存 / 写缓存 | cache read / cache write | cache creation |
| 未缓存 | uncached | non-cached |
| 对话被压缩 | compaction | summarization |
| 单价 / 价表 | unit price / price table | rate card, price file, price list |
| 没有单价的模型 | models without a unit price | unpriced models |
| 估价 | estimated cost | approximate cost |
| 花费 | cost | spend |
| 用量 | usage | consumption |
| 统计 | stats | analytics |
| 保存设置 | retention | storage policy |
| 磁盘 | disk (CLI) | |
| 代理模式 / 驱动模式 | proxy mode / driver mode | |
| 合并的证书包 | merged certificate bundle | CA bundle |
| 信任插件 | trust plugin | |
| 启动入口 | launch shim | launcher |
| 特权助手 | capability helper | privileged helper, capture helper, kernel helper, redirector helper, helper loader, redirector loader |
| 开机自启的用户服务 | login item (CLI) | autostart, startup item |
| 安装清单 | install manifest | |
| 旧采集 | old capture (CLI) | legacy capture |
| 命令行 / 桌面版 | CLI / desktop | |
| 本机网络环境 | local network environment | |
| 连接的域名 / 请求里写的域名 | connected host / requested host | |
| 厂商 | vendor | |
| 项目 | project | workspace |
| 总览 | overview | dashboard |
| 主机页 / 请求详情 | host page / request detail | |
| 设置:存储 / 价格 / 外观 / 主题 | settings: storage / prices / appearance / theme | preferences |
| 技术细节 | technical details | advanced, debug info |
| 问题 | problem (CLI) | issue |
| 在采 / 没在采 | capturing / not capturing (CLI) | |
| 部分在采 | partly capturing | partially capturing |
| 在跑 / 已停 | running / stopped (CLI) | |
| 已信任 | trusted (CLI) | |
| 完好 | intact | |
| 该在的东西不在了 | missing (CLI) | gone |
| 采集降级 | degraded (CLI) | |
| 卸载后还留着 | left behind (CLI) | leftover |
| 失败 | failed (CLI) | |
| 需要人看 | needs a look | attention needed |
| 新 | new | |
| 逐字 | verbatim (CLI) | exact copy |
| 估算(≈) | estimate | approx, approximately, roughly |
| 结构估计 | structural estimate | |
| 推测 | inferred | guessed, probably |
| 不知道 | not known | |
| 算不出 | cannot be computed | |
| 未记录 | not recorded | |
| 只记日志 | log only | |
| 只有元数据 | metadata only | |
| 只存了长度 | length only | |
| 已截断 | truncated | cut off, clipped |
| 不完整 / 没收全 | incomplete | |
| 没传完 | not fully transferred | |
| 源头省略了 | omitted by the source | |
| 没解压出来 | not decompressed | |
| 解析不出来 | could not be parsed | |
| 重新序列化过 | reserialized, not the wire bytes | reserialised |
| 由前几条记录拼出 | reconstructed from earlier records | |
| 客户端的摘要 | a client summary, not the original | |
| 服务端改过上下文 | the server edited the context | |
| 加密 | encrypted; no plaintext | |
| 不透明 | opaque — no plaintext on the wire | |
| 不能回源 | not addressable | |
| 取不到字节 | bytes could not be fetched | |
| 已遮挡 | masked | |
| 显示遮挡的原值 | show | reveal, unmask |
| 只读 | read-only | |
| 保真未知 | fidelity unknown | |
| 采样显示 | sampled | |
| 至少 / 起 | at least / from | |
| usage 未返回 | usage not returned | |
| 开启采集 | start capturing | enable capture, turn capture on |
| 关掉采集 | stop capturing | disable capture, turn capture off |
| 重新安装采集 | install capture again | reinstall |
| 存内容 / 不存内容 | keep bodies / headers only | |
| 复制 | copy | |
| 导出 | export | download |
| 上一步 / 下一步 | previous step / next step | prev step |
| 跟随最新 | follow latest | auto-scroll |
| 全部展开 / 全部折叠 | expand all / collapse all | |
| 收起 / 展开侧栏 | collapse / expand sidebar | |
| 对比 | compare | |
| 在回放中打开 | open in replay | |
| 去处理 | fix it | |
| 重试 | retry | try again |
| 亮 / 暗 / 跟随系统 | light / dark / follow system | system default |
| 全部 | all | |
| 载入中 | loading… | |

1. 一个概念一个词,处处一样:本表是唯一的对照,同一概念的第二种写法是缺陷。
2. 失败句只出自一张表:看板读 `src/cli/words.mjs : FAILURE_WORDS`,不翻 `labels/capture.mjs` 里的中文副本;未知 `(where, code)` 与 CLI 同样回退。
3. 保真词从不弱化:estimate 不变成 about,inferred 不消失,not captured 不写成空白。
4. harness 名与类别 id 是数据,从不翻译。
5. 用户文字里没有机读码、节号、决策号、trocar 自身的源文件路径(D58②;守卫 `english.test.mjs`)。

