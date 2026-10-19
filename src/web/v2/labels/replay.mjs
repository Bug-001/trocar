// labels/replay.mjs — the words of the replay desk (回放台): the session head, the 会话保真行 and the session info popover
// (1.2 §会话头), the step head and its 缓存 / 组成 / ≈ $ popovers and the compare menu (2.2 §步头), the lane kind table's words
// (2.1, owned here for the whole board). Fixed text keyed by asight's own closed sets — the cache-predicate states
// (core/metrics.mjs), the server's `cacheBreak.cause` / attribution closed sets (src/view/analyze.mjs CAUSE_META) and the lane
// kinds — never by a harness-defined code (1.5 §数据规则): those carry their own words from the server. English causeLabel /
// fixHint and field names stay out of the UI (raw values go to 技术细节).
import { L } from '../core/labels.mjs'

// ── the lane kind table (2.1 owns it; 1.3's rows, 2.2's buckets, 2.6 §B's drawer title all read it) ─────────────────
// Keyed by the server's closed kind set only, never by harness / provider (invariant 3). `row` says which trace row the
// kind lands on ('saw' = the main track's own axis, 'sub' = the 子 agent group, 'bg' = the 后台调用 group, 'tc' = the token
// 计数 row built from `probes`, not a lane); `bucket` is the cost bucket (null = not billed, not in any bucket).
export const LANE_KIND = Object.freeze({
  main: { word: '主对话', row: 'saw', bucket: 'main', hint: 'agent 和模型的对话本身;横轴按它的步排' },
  subagent: { word: '子 agent', row: 'sub', bucket: 'sub', hint: '主 agent 另开的独立对话,有自己的上下文' },
  monitor: { word: '安全审查', row: 'bg', bucket: 'bg', hint: 'agent 让模型审查一步操作;它读取完整上下文。悬停看它大约审到第几步(推测)' },
  notify: { word: '通知摘要', row: 'bg', bucket: 'bg', hint: 'agent 让模型把最近的活动写成一句通知' },
  titlegen: { word: '生成标题', row: 'bg', bucket: 'bg', hint: 'agent 让模型给会话起标题' },
  quota: { word: '保活检查', row: 'bg', bucket: 'bg', hint: '回复上限极小的检查调用,回复不用' },
  aux: { word: '其他后台调用', row: 'bg', bucket: 'bg', hint: '主对话和子 agent 之外的其他辅助调用' },
  probe: { word: '预热请求', row: 'bg', bucket: 'bg', hint: 'agent 自己标出的预热请求:先把缓存写好,不是对话的一步' },
  'token-count': { word: 'token 计数', row: 'tc', bucket: null, hint: 'token 计数:不生成回复、不计费' },
})
// a kind the table does not know yet (the server grew one): its own words, the 后台调用 row, no guess about the bucket
export const laneKind = (kind) => LANE_KIND[kind] || { word: '其他调用', row: 'bg', bucket: 'bg', hint: '看板还不认识这种调用' }
export const laneWord = (kind) => laneKind(kind).word

// ── the cache predicate's own words (2.2 §缓存判定; the states are core/metrics.mjs : CACHE_STATES) ──────────────────
// cacheSentence(state, {laneW, causeW, attrW, hitPct, warm, inferred, errMsg, zeroInput}) → the sentence the 缓存 popover opens
// with. `laneW` is the lane word of the call the button is about (the step bar's is always 主对话).
export const STRUCT_TIP = '按块的结构比对得出,不是服务商真实的缓存边界;权威值是 DuckDB 的 prefix_sha256'
export function cacheSentence(st, o = {}) {
  const laneW = o.laneW || '主对话'
  switch (st.state) {
    case 'failed': return `这次调用失败${o.errMsg ? `(${o.errMsg})` : ''},没有用量,不计价`
    case 'no-usage': return o.zeroInput ? '用量里没有输入数,算不出(不是 0%)' : '没有返回用量,算不出(不是 0%)'
    case 'first': return `${laneW}的第一次调用,没有可对比的前一次` + (o.warm ? ' · 读到的缓存来自更早的调用留下的相同开头(比如别的会话),不是异常' : '')
    case 'ttl-rebuild': return '缓存过期:前面没变,重新写入'
    case 'provider-contradiction': return '前面和对比的那一步相同,却没读到缓存 —— 可能是服务商一侧'
    case 'changed': return st.cause === 'compaction'
      ? `对话被压缩${o.inferred ? '(推测)' : ''},整个上下文重新写入` + (o.attrW ? ` · ${o.attrW}` : '')
      : `缓存在这一步断开:${o.causeW || '原因未知'}` + (o.attrW ? ` · ${o.attrW}` : '')
    case 'low-hit': return o.hitPct != null ? `前面没变,但只命中了 ${o.hitPct}%` : '前面没变,但没有命中'
    case 'reused': return st.quiet === 'volatile-nonce-only' ? '只有每次都变的块变了,不影响缓存' : '复用了前面的缓存'
    default: return '这一步没有采集到请求,缓存无从对比' // unjudged: no captured request to compare a prefix from
  }
}
// the states whose verdict stands on a block-structure comparison (2.2 MUST: they carry the visible 结构估计 mark)
export const STRUCT_STATES = new Set(['ttl-rebuild', 'provider-contradiction', 'changed', 'low-hit'])
export const isStructState = (st) => STRUCT_STATES.has(st && st.state) || (st && st.state === 'reused' && st.quiet === 'volatile-nonce-only')

// the server's cause closed set (CAUSE_META) in plain words; anything else is 原因未知 and the raw value goes to 技术细节
export const CAUSE_WORD = Object.freeze({
  compaction: '对话被压缩', 'tool-array-reorder': '工具列表的顺序变了', 'json-key-reorder': '请求里 JSON 键的顺序变了',
  'content-changed': '前面某一块的内容变了',
})
export const causeWord = (cause) => CAUSE_WORD[cause] || '原因未知'
// the five attribution values, five words (2.2 §缓存判定)
export const ATTR_WORD = Object.freeze({
  yours: '请求每次拼得不一样,可以修', harness: 'agent 的正常机制', review: '需要人看',
  harmless: '不影响', 'provider-excluded': '服务商不计入缓存',
})

// ── the 缓存 popover ──────────────────────────────────────────────────────────────────────────────────────────────────
export const USAGE_NULL_TIP = '服务商没有返回这个数'
export const BREAK_COST_WHY = Object.freeze({
  'no-write-counter': '多花算不出:服务商没有返回写缓存数', 'no-price': '多花算不出:没有这个模型的单价',
  'no-usage': '多花算不出:没有返回用量', 'no-ref': '多花算不出',
})
export const CACHE_SEMANTICS_UNKNOWN = '这个服务商的缓存数字含义不确定'
export const JUMP_TO_CHANGE = '跳到变化处 ›'

// ── the 组成 popover ──────────────────────────────────────────────────────────────────────────────────────────────────
export const SEG_NAME = Object.freeze({ tools: '工具定义', system: '系统提示', history: '历史对话', task: '本轮新内容' })
export const COMP_CALIBRE = '按内容字节,不含请求的 JSON 外壳;token 是按字符估的'
export const compCulprit = (seg, pct) => `最大的一段:${SEG_NAME[seg] || seg}(${pct}%),每次请求都重发`
export const TOOLS_ESTIMATED = '工具定义只存了元数据,这一段的大小是估的'
export const DIAGNOSE_ONLY = '这里只说增量来自哪里;要不要删,由 agent 自己决定'
export const COMPACTION_REWRITE = '对话被压缩,整个上下文重写,不是逐块追加'
export const compOffPage = (n) => `第 ${n} 步的内容不在当前这一页,增量算不出`
export const COMP_SELF = Object.freeze({ paged: '这一步的内容不在当前这一页,组成算不出', unparsed: '这一步的请求解析不出来', none: '这一步没有采集到请求' })
export const compSize = (n) => `这次请求的内容 ${n}`
export const growthLine = (delta, segW, less = false) => `比上一步${less ? '少' : '多'} ${delta}` + (segW ? `,主要在${segW}` : '')
export const growthVs = (n, delta, segW, less = false) => `比第 ${n} 步${less ? '少' : '多'} ${delta}` + (segW ? `,主要在${segW}` : '')
export const LOAD_STEP = (n) => `载入第 ${n} 步`

// ── the ≈ $ popover ───────────────────────────────────────────────────────────────────────────────────────────────────
export const COST_CALIBRE = '本地估价(用量 × 单价),不是账单'
export const PRICE_BY_KEY = (key) => `按 ${key} 的单价`
export const SEE_PRICES = '看单价 ›'
export const COST_WHY = Object.freeze({
  failed: '调用失败,不计价', 'no-usage': '没有返回用量,不计价', 'no-price': '没有这个模型的单价',
})
export const priceTableNote = (table, err) => (table ? '' : err ? `价表读不出:${err}` : '价表载入中')

// ── the compare menu (2.3 §两个对比步; the control itself is 2.2's) ────────────────────────────────────────────────────
export const COMPARE = '对比'
export const compareAt = (n) => `对比第 ${n} 步 ×`
export const COMPARE_DEFAULT = '上一步(默认)'
export const compareDefaultAt = (n) => `第 ${n} 步(默认)`
export const COMPARE_PICK = '选一步…'
export const COMPARE_WITH = '和第'
export const COMPARE_WITH2 = '步对比'
export const COMPARE_OK = '确定'
export const COMPARE_RANGE = (m) => `1 到 ${m} 之间、不是当前这一步`

// ── the three buttons and their popovers (the button word carries the short state; the rest is behind it) ────────────
export const CACHE_TITLE = '缓存'
export const CACHE_POPOVER_LABEL = '这一步的缓存'
export const COMP_TITLE = '组成'
export const COMP_POPOVER_LABEL = '这次请求的组成'
export const COMP_BTN = '组成'
export const COMP_BTN_NONE = '组成 —'
export const COST_TITLE = '≈ $'
export const COST_POPOVER_LABEL = '这一步的估价'
export const CMP_RESET = '回到上一步'

// ── the step head (2.2 §步头) ─────────────────────────────────────────────────────────────────────────────────────────
export const STEP_PREV = '上一步'
export const STEP_NEXT = '下一步'
export const stepNo = (n, m) => `第 ${n} / ${m} 步`
export const callNo = (laneW, k, m) => `${laneW} · 第 ${k} / ${m} 次调用`
export const askNo = (k) => `第 ${k} 次提问`

// ── the session head (1.2 §会话头) ────────────────────────────────────────────────────────────────────────────────────
export const BACK = '‹ 会话'
export const UNTITLED = '未命名会话'
export const FOLLOW = '跟随最新'
export const SESSION_INFO_LABEL = '这次会话的概况'
export const MULTIPLE_AGENTS = '多个 agent'
export const TITLE_FROM_META = '标题来自 agent 自己的记录,不是采集到的内容'
export const TITLE_FROM_PROMPT = '取自第一条提问'
export const TITLE_UNTITLED_TIP = '没有可用的标题;开始时间来自第一步的记录'
export const MULTIPLE_AGENTS_TIP = '同一个会话 id 下混了几种 agent 的记录'
export const PROJECT = '项目'
export const GUESS = '推测'

// ── the 会话保真行 (1.2 §会话保真行): each fact's plain words ────────────────────────────────────────────────────────
export const truncFact = (shown, total, fileMb) => `只显示了最近 ${shown} / ${total} 次调用(文件 ${fileMb} MB)`
export const unknownFact = (n) => `${n} 条记录没有解析器能读,没有画出来`
export const LOGGED_FACT = '次调用只记了日志,不在回放里 ›'
export const loggedFact = (n) => `${n} ${LOGGED_FACT}`
export const FILES_FACT = '个采集文件没读全,这个会话可能缺内容 ›'
export const filesFact = (n) => `有 ${n} ${FILES_FACT}`
export const GAP_FACT = '这段时间采集出过错,读到的范围内可能缺调用(推测)· 采集记录 ›'

// ── the context window (2.3): sections, block marks, the 调用保真行, the 窗口行, the 变化线, the代替态 ────────────────
export const SECTION_NAME = Object.freeze({ tools: '工具定义', system: '系统提示', messages: '对话' })
export const SECTION_VERBATIM = '以下逐字'
export const SECTION_SIZE_TIP = '这一段各块内容的字节数之和'
export const SECTION_SIZE_EST = '≈'
export const SECTION_SIZE_EST_TIP = '工具定义只存了元数据,大小是估算'
export const HALF_MARK = '◐'
export const WINDOW_LINE = '这一步的内容不能回到原始字节(经过重新解析)'
export const FOLD_ALL_OPEN = '全部展开'
export const FOLD_ALL_CLOSE = '全部折叠'
export const FOLD_ALL_OPEN_TIP = '展开这一步的每一张提问卡'
export const FOLD_ALL_CLOSE_TIP = '折叠这一步的每一张提问卡'

// the 调用保真行 (2.3): one fact per field, joined by 「 · 」; the closed sets of contextState and the three *Incomplete flags
export const CTX_FACT = Object.freeze({
  partial: '上下文不完整:缺前面的记录', partialBare: '上下文不完整', unknownWhy: '原因未知',
  reconstructed: '由前几条记录拼出', server_edited: '服务端改过上下文,这里不是模型收到的全部',
  fallback: '上下文没采全',
})
export const REQ_FACT = Object.freeze({ truncated: '在采集上限处截断', partial: '没收全' })
export const WS_FACT = Object.freeze({ partial: '这条连接前面的消息缺了', truncated: '有消息超过上限,只存了大小', undecoded: '有消息没解压出来', nonVerbatim: '有消息只存了大小' })
export const RESP_FACT = Object.freeze({ undecoded: '没解压出来', binary: '不是文本', notJson: '不是 JSON', empty: '没有回复体', unparsed: '有事件没读出来,回复可能不全', truncated: '在采集上限处截断' })
export const INCOMPLETE_WORD = Object.freeze({ req: '请求', ws: '消息', resp: '回复' })
export const reqEncodingFact = (enc) => `请求体在线上压缩过(${enc}),这里是解压后的确切文字`

// block-level marks (2.3 §保真标): one visible word per unproven block; the codes are the 3.2 closed set plus
// asight's own opened-body outcomes (notfetched · reserialized · unknown)
export const FF_WORD = Object.freeze({
  metadata: '只有元数据', opaque: '加密,没有明文', summarized: '客户端的摘要,不是原文', omitted: '源头省略了',
  truncated: '源头就截断了', unaddressable: '不能回源', unknown: '保真未知', notfetched: '取不到字节',
  reserialized: '重新序列化过,不是线上字节', verbatim: '逐字',
})
export const FF_TIP = Object.freeze({
  metadata: '只有元数据:完整的 JSON schema 没有被采集(D15 前的旧 trace),模型收到的是完整 schema',
  opaque: '加密 / 涂黑的推理:线上只有签名或密文,没有明文可还原',
  summarized: '客户端的摘要顶替了原文(例如压缩),不是逐字原文',
  omitted: '源头省略了这一块的内容',
  truncated: '源本身就没抓全(采集上限处截断);全文不在盘上',
  unaddressable: '不能回源:这一块没有可定位的线上字节跨度,正文是块里内联带来的',
  unknown: '保真未知:服务端给的保真值不在认识的闭集里,不当作逐字',
  notfetched: '取不到字节:回源失败,原因见正文;再点开会重试',
  reserialized: '这些字节在进入采集时被重新序列化过,不是线上字节的逐字记录',
  verbatim: '逐字:这一块存下来的就是线上的字节,没有改写(AC-1)',
})
export const INLINE_NOTE = '这段文字是块里带来的,不是从原始采集里逐字切出来的'
export const NO_BODY = '这一块没有正文,也没有回源定位'
export const FETCHING = '回源中…'
export const clipNote = (n) => `…(共 ${n} 字符,这里只显示前 20000)`
// the raw panel's reply / the drawer's reply: the display clip said once, in 2.6 §A's own words (the context window's
// blocks keep clipNote above — 2.3 K-07 pins that wording for them)
export const clipShownNote = (shown, total) => `已截断显示 · 前 ${shown} / 共 ${total} 字符`

// block-head words (2.3 §block 卡)
export const CACHE_MARK = '缓存标记'
export const CACHE_MARK_TIP = '请求在这一块声明了缓存位置;缓存怎么处理这个标记,各服务商不同'
export const VOLATILE_MARK = '每次都变 · 不影响缓存'
export const VOLATILE_MARK_TIP = '这一块每次调用字节都会变,却被排除在缓存键之外,不影响缓存命中'
export const NEW_MARK = '新'
export const NEW_MARK_TIP = '这一块不在内容对比步里:本步新增到上下文的内容(属于重发的增量)'
export const CHARS_WORD = '字符'
// head.tag's closed set in plain words (2.3 Edge「块头 tag 的中文」); a data suffix (a tool name, MCP) rides along
export const TAG_WORD = Object.freeze({
  def: '指令', user: '对话', say: '对话', text: '对话', 'system-reminder': '系统提醒', thinking: '思考',
  observation: '工具结果', image: '图片', document: '文档',
})
export const TAG_ACTION = '工具调用'
export const TAG_ERROR = '错误'
export const TAG_UNKNOWN = '原因未知'

// the 变化线 (2.3 §变化线)
export const STRUCT_EST_WORD = '结构估计'
export const changeLine = (k, causeW) => (k != null ? `从这里起和第 ${k} 步不同 · ${causeW}` : `从这里起有变化 · ${causeW}`)
export const CHANGE_COMPACT = '对话被压缩:以下整段重写'
export const CHANGE_COMPACT_INFERRED = '推测'
export const CHANGE_REF_HINT = '结构参考,非真实边界'
export const changeFirstTip = (headW) => `第一个不同的块:${headW}`
export const removedList = (n, k2) => `第 ${k2} 步里有、这一步没有的块:${n} 个`

// the 代替态 (1.4 ⑤–⑧, words 2.3)
export const PAGED_TITLE = '这一步的内容不在当前这一页'
export const PAGED_FULL = '原始记录完整在盘上'
export const PAGED_PARTIAL = '采到的那部分在盘上'
export const LOAD_THIS_STEP = '载入这一步'
export const RETRY = '重试'
export const UNPARSED_TITLE = '这一步的请求解析不出来,没有上下文可以显示'
export const UNPARSED_KEEP = '原始记录原样在盘上'
export const NO_REQUEST = '这一步没有采集到请求'
export const LOADING = '载入中…'

// ── the session info popover (1.2 §信息弹出层, the rows in order) ────────────────────────────────────────────────────
export const COST_LINE = '≈ 花费'
export const BUCKETS = Object.freeze({ main: '主对话', sub: '子 agent', bg: '后台调用' })
export const COST_FROM = '起'
export const noPriceCalls = (n) => `${n} 次模型调用没有单价`
export const NO_ANY_PRICE = '没有这些模型的单价'
export const HIT_LINE = '主对话缓存命中'
export const HIT_MAIN_ONLY = '只算主对话'
export const HIT_UNMEASURED = '算不出(没有返回用量)'
export const BREAKS_LINE = (n) => `缓存断开 ${n} 处(${L.STRUCT_EST})`
export const BREAK_COST_LINE = '≈ 多花'
export const BREAK_COST_SOME = (n) => `其中 ${n} 处算不出`
export const WORST_AT = (n) => `最贵在第 ${n} 步 ›`
export const FAILED_LINE = (n) => `调用失败 ${n} 次 ›`
export const COMPACTION_LINE = (n) => `压缩 ${n} 次`
export const COUNTS_LINE = { sub: (n) => `子 agent ${n} 个`, bg: (n) => `后台调用 ${n} 次`, probe: (n) => `token 计数 ${n} 次` }
export const START_LINE = '开始'
export const DURATION_WORD = '时长'
export const SESSION_ID = '会话 id'
export const COPY = '复制'
export const TRUNCATED_NOTE = (shown) => `只算了显示的 ${shown} 次调用`
export const MODEL_CALLS = (n) => `模型调用 ${n} 次`

// ── the trace (1.3): the problem lane, the cache band's four states, the view switch, the overlay rows ───────────────
export const PROBLEM_ROW = '问题'
export const problemPager = (k, n) => (n ? `问题 ${k == null ? '—' : k}/${n}` : '问题')
export const PROBLEM_PREV = '上一个问题'
export const PROBLEM_NEXT = '下一个问题'
export const breakFlagTip = (n, costW, struct) => `第 ${n} 步缓存断开 · ${costW}` + (struct ? ` · ${L.STRUCT_EST}` : '')
export const BREAK_COST_NONE = '多花算不出'
export const failTip = (n, msg) => `第 ${n} 步调用失败${msg ? `(${msg})` : ''}`
export const COMPACT_WORD = '压缩'
export const compactTip = (n, inferred) => `第 ${n} 步对话被压缩:历史被重写,整个上下文重新写入${inferred ? '(推测)' : ''}`
// the cache band's four hover shapes, in the predicate's own order
export const CACHE_CELL_FAILED = '缓存 失败'
export const CACHE_CELL_NONE = '缓存 —'
export const CACHE_CELL_NONE_TIP = '没有返回用量,算不出(不是 0%)'
export const cacheCellPct = (p) => `缓存 ${p}%`
export const cacheCellUnknown = (p) => `缓存 ${p}%?`
export const CACHE_LEGEND = '高 = 命中,中 = 部分,低 = 没到,虚线 = 没有用量'
export const CACHE_LEGEND_UNK = '含义不确定'
export const VIEW_CTX = '上下文大小'
export const VIEW_COST = '花费'
export const COMP_LEGEND = '颜色 = 内容类型(按内容大小估算)'
export const COST_LEGEND = '柱高 = 这一步的估价(用量 × 单价)· 斜纹 = 算不出'
export const showSteps = (a, b) => `显示第 ${a}–${b} 步`
export const noMainLane = (laneW) => `这个会话没有主对话,时间轴按${laneW}的调用排`
export const ONLY_MAIN = '这个会话只有主对话'
export const peakCtx = (v) => `${v} tok` // kf() bakes the number; the peak is the main lane's real total_input
export const askScaleTip = (k, preview) => `第 ${k} 次提问` + (preview ? ` ${preview}` : '')
// the overlay rows' names (2.1 / 1.3): the counts are the full truth, never the drawn ticks
export const SUBAGENT_ROW = (n) => `子 agent ${n} 个`
export const BG_ROW = (n) => `后台调用 ${n} 次`
export const TC_ROW = (n) => `token 计数 ${n} 次`
export const laneTimes = (word, n) => `${word} ${n} 次`
export const callsWord = (n) => `调用 ${n} 次`
export const TC_SAMPLED_TIP = (m, n) => `画了 ${m} 根,共 ${n} 次;点哪里都打开最近的一次`
export const TC_NO_SIZE = (j) => `其中 ${j} 次没有返回大小,没有画`
export const FLAGGED_WORD = '标记了问题' // S13 landed: flagged === true draws a mark on the collapsed 后台调用 row
export const REVIEW_TIP = (k) => `按时间推断:这次调用发出时,主对话已到第 ${k} 步`

// ── the outline (2.5) ────────────────────────────────────────────────────────────────────────────────────────────────
export const OUTLINE_HEAD = '这一步的输入'
export const GRP_TOOLS = '工具定义'
export const GRP_SYS = '系统提示'
export const GRP_ASK = '提问'
export const NO_TOOLS = '这一步没有工具定义'
export const NO_SYS = '这一步没有系统提示'
export const NO_ASK = '这一步的上下文里没有认得出的提问'
export const MCP_WORD = 'MCP'
export const askSince = (n) => `第 ${n} 步起`
export const QUERY_GUESS_TIP = '这条是不是人写的提问,是推测的'
export const UNPARSED_LINE = '请求体解析不出来'

// ── the resource explorer (2.4) ──────────────────────────────────────────────────────────────────────────────────────
export const RES_SECTION = '资源 · 整个会话'
export const RES_GRP = Object.freeze({
  file: '读过的文件', seen: '只见到名字', load: '载入的说明文件', cap: '工具与能力', dl: '目录与链接', comp: '上下文压缩', other: '其他资源',
})
export const OTHERS_ROW = (n) => `其他 ${n} 项`
// the lifecycle words take the composed step word (「第 5 步」, or 「第 5 次调用」 when the session has no main lane)
export const lifeIn = (at) => `${at}读入`
export const LIFE_IN_CTX = '在上下文中'
export const lifeEvicted = (at) => `${at}压缩时移出`
export const lifeLoaded = (at) => `${at}载入`
export const lifeSeen = (at) => `${at}出现`
export const seenTip = (k, at) => `见过 ${k} 次 · 第一次在${at}`
export const SEEN_GROUP_TIP = '从工具结果和文字里按路径的样子挑出来的名字,可能漏,也可能多;agent 没有打开过它们,这里没有内容;最多列 200 个'
export const SHOW_ALL = (n) => `显示全部 ${n} 个`
export const HIDE_ALL = '收起'
export const NO_LEDGER = '这个 agent 的记录里没有资源信息'
export const NO_RESOURCES = '没有资源记录(这个 agent 可能不提供)'
export const DIR_WORD = '目录'
export const LINK_WORD = '链接'
export const compactRow = (at, from, to) => `${at} · 压缩:${from} → ${to} 条消息`
export const summarizeRow = (at, out) => `${at} · 摘要(输出 ${out} token)`
export const ONLY_CALLS = '只看到调用'
export const ONLY_CALLS_TIP = '看到了这次调用,驻留的正文不在采集到的上下文里'
export const viewNameTip = (name) => `看 ${name} 的内容`
export const jumpStepTip = (at) => `跳到${at}`
// the capability's two tiers, by 2.3's proof rule
export const CAP_VERBATIM = '工具定义逐字采集了,在上下文窗里展开工具块看完整 schema'
export const CAP_METADATA = '只有元数据:名字、参数个数、描述长度;不是逐字的 schema'
// the pinned panel's honest fallbacks
export const RES_NOT_FOUND = '在这一步的上下文里找不到唯一对应的块:它可能更早读入,或已被移出。点这一行的步号,跳到它读入的那一步。'
export const RES_NOT_LOADED = '这一步的正文还没载入,那一页到了就会显示。'

// ── the raw panel (2.6 §A) ───────────────────────────────────────────────────────────────────────────────────────────
export const RAW_WORD = '原始数据'
export const RAW_HEAD = (n) => `原始数据 · 第 ${n} 步`
export const REPLY_WORD = '回复'
export const toolCallRow = (name) => `调用工具 ${name}`
export const stopReasonRow = (v) => `停止原因 ${v}`
export const REPLY_PARSED = '解析后的回复'
export const REPLY_PARTIAL = '回复没采全'
export const RAW_REPLY = '原始回复'
export const rawReplyRow = (chars) => `原始回复 · ${chars} 字符 ›`
export const rawReplyNth = (k) => `原始回复 第 ${k} 条`
export const NO_RAW_REPLY = '原始回复没有可回源的字节'
export const REQ_PARAMS = '请求参数'
export const NO_PARAMS = '这条记录没有可回源的请求参数'
export const UNPARSED_PARAMS = '请求体解析不出来,列不出参数'
export const EXTRA_MSGS = (n) => `这次调用里客户端后来又发的消息 · ${n} 条 ›`
export const TRANSPORT_HTTP = '传输 HTTP'
export const TRANSPORT_WS = '传输 WebSocket'
export const VENDOR_WORD = '厂商'
export const BACK_TO_RAW = '回到原始数据'
export const FAILED_NO_REPLY = '这次调用失败,没有回复'
export const TECH_DETAILS = '技术细节'

// ── the call drawer (2.6 §B) ────────────────────────────────────────────────────────────────────────────────────────
export const DRAWER_CLOSE = '关闭'
export const backToStep = (n) => `← 回到第 ${n} 步`
export const inputBlocks = (n) => `输入 · ${n} 个块`
export const NO_INPUT = '这次调用没有输入块'
export const INPUT_NOT_PAGE = '这次调用的输入不在当前这一页'
export const VERBATIM_FOLD = (n, unit) => `逐字 · ${n} ${unit} · 点开`
export const foldAt = (word, n, unit) => `${word} · ${n} ${unit} · 点开`
export const TC_INPUT = Object.freeze({
  full: '请求体不在会话里,到 流量 页按「token 计数」类别逐条看(保存级别:全部)',
  log: '请求体不在会话里,到 流量 页按「token 计数」类别逐条看(保存级别:只记日志)',
  old: '请求体不在会话里,到 流量 页按「token 计数」类别逐条看(保存级别:较早采集的记录,只存了长度)',
})
export const TC_MEASURED = (n) => `量出来 ${n} token`
export const OPAQUE_ROW = '不透明 · 线上只有签名,没有明文'
