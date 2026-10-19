// labels/replay.mjs — the words of the replay desk (回放台): the session head, the 会话保真行 and the session info popover
// (1.2 §会话头), the step head and its 缓存 / 组成 / ≈ $ popovers and the compare menu (2.2 §步头), the lane kind table's words
// (2.1, owned here for the whole board). Fixed text keyed by asight's own closed sets — the cache-predicate states
// (core/metrics.mjs), the server's `cacheBreak.cause` / attribution closed sets (src/view/analyze.mjs CAUSE_META) and the lane
// kinds — never by a harness-defined code (1.5 §数据规则): those carry their own words from the server. The server's own
// causeLabel / fixHint and field names stay out of the UI (raw values go to technical details).
import { L } from '../core/labels.mjs'

// ── the lane kind table (2.1 owns it; 1.3's rows, 2.2's buckets, 2.6 §B's drawer title all read it) ─────────────────
// Keyed by the server's closed kind set only, never by harness / provider (invariant 3). `row` says which trace row the
// kind lands on ('saw' = the main track's own axis, 'sub' = the 子 agent group, 'bg' = the 后台调用 group, 'tc' = the token
// 计数 row built from `probes`, not a lane); `bucket` is the cost bucket (null = not billed, not in any bucket).
export const LANE_KIND = Object.freeze({
  main: { word: 'main thread', row: 'saw', bucket: 'main', hint: 'The exchange between the agent and the model itself; the horizontal axis follows its steps' },
  subagent: { word: 'sub-agent', row: 'sub', bucket: 'sub', hint: 'A separate thread the main agent opened, with its own context' },
  monitor: { word: 'safety review', row: 'bg', bucket: 'bg', hint: 'The agent asks the model to review an action; it reads the full context. Hover to see the step it most likely reviewed (inferred)' },
  notify: { word: 'notification summary', row: 'bg', bucket: 'bg', hint: 'The agent asks the model to sum up recent activity in a one-line notification' },
  titlegen: { word: 'title generation', row: 'bg', bucket: 'bg', hint: 'The agent asks the model to give the session a title' },
  quota: { word: 'keep-alive check', row: 'bg', bucket: 'bg', hint: 'A check call with a tiny reply limit; the reply is not used' },
  aux: { word: 'other background call', row: 'bg', bucket: 'bg', hint: 'Any other helper call outside the main thread and the sub-agents' },
  probe: { word: 'warm-up request', row: 'bg', bucket: 'bg', hint: 'A warm-up request the agent marked itself: it writes the cache ahead of time; not a step of the main thread' },
  'token-count': { word: 'token count', row: 'tc', bucket: null, hint: 'Token count: generates no reply and is not billed' },
})
// a kind the table does not know yet (the server grew one): its own words, the 后台调用 row, no guess about the bucket
export const laneKind = (kind) => LANE_KIND[kind] || { word: 'other call', row: 'bg', bucket: 'bg', hint: 'The board does not know this kind of call yet' }
export const laneWord = (kind) => laneKind(kind).word

// ── the cache predicate's own words (2.2 §缓存判定; the states are core/metrics.mjs : CACHE_STATES) ──────────────────
// cacheSentence(state, {laneW, causeW, attrW, hitPct, warm, inferred, errMsg, zeroInput}) → the sentence the 缓存 popover opens
// with. `laneW` is the lane word of the call the button is about (the step bar's is always 主对话).
export const STRUCT_TIP = 'From comparing the block structure, not the provider\'s real cache boundary'
export function cacheSentence(st, o = {}) {
  const laneW = o.laneW || 'main thread'
  switch (st.state) {
    case 'failed': return `This call failed${o.errMsg ? ` (${o.errMsg})` : ''}; no usage, no cost`
    case 'no-usage': return o.zeroInput ? 'The usage has no input count, so this cannot be computed (not 0%)' : 'No usage returned, so this cannot be computed (not 0%)'
    case 'first': return `The first ${laneW} call; there is no earlier call to compare with` + (o.warm ? ' · the cache it read came from an identical prefix left by an earlier call (for example another session); this is not a fault' : '')
    case 'ttl-rebuild': return 'Cache expired: the prefix did not change and was written again'
    case 'provider-contradiction': return 'The prefix matches the compared step, yet no cache was read — possibly on the provider side'
    case 'changed': return st.cause === 'compaction'
      ? `Compaction${o.inferred ? ' (inferred)' : ''}: the whole context was written again` + (o.attrW ? ` · ${o.attrW}` : '')
      : `Cache break at this step: ${o.causeW || 'cause unknown'}` + (o.attrW ? ` · ${o.attrW}` : '')
    case 'low-hit': return o.hitPct != null ? `The prefix did not change, but the cache hit only ${o.hitPct}%` : 'The prefix did not change, but there was no cache hit'
    case 'reused': return st.quiet === 'volatile-nonce-only' ? 'Only blocks that change every call changed; the cache is not affected' : 'Reused the earlier cache'
    default: return 'No request was captured for this step, so there is nothing to compare the cache with' // unjudged: no captured request to compare a prefix from
  }
}
// the states whose verdict stands on a block-structure comparison (2.2 MUST: they carry the visible 结构估计 mark)
export const STRUCT_STATES = new Set(['ttl-rebuild', 'provider-contradiction', 'changed', 'low-hit'])
export const isStructState = (st) => STRUCT_STATES.has(st && st.state) || (st && st.state === 'reused' && st.quiet === 'volatile-nonce-only')

// the server's cause closed set (CAUSE_META) in plain words; anything else is 原因未知 and the raw value goes to 技术细节
export const CAUSE_WORD = Object.freeze({
  compaction: 'compaction', 'tool-array-reorder': 'the order of the tool list changed', 'json-key-reorder': 'the order of JSON keys in the request changed',
  'content-changed': 'the content of an earlier block changed',
})
export const causeWord = (cause) => CAUSE_WORD[cause] || 'cause unknown'
// the five attribution values, five words (2.2 §缓存判定)
export const ATTR_WORD = Object.freeze({
  yours: 'the request is built differently each time; fixable', harness: 'the agent\'s normal behaviour', review: 'needs a person to look',
  harmless: 'no effect', 'provider-excluded': 'the provider does not count it in the cache',
})

// ── the 缓存 popover ──────────────────────────────────────────────────────────────────────────────────────────────────
export const USAGE_NULL_TIP = 'The provider did not return this number'
export const BREAK_COST_WHY = Object.freeze({
  'no-write-counter': 'Extra cost cannot be computed: the provider returned no cache write count', 'no-price': 'Extra cost cannot be computed: no unit price for this model',
  'no-usage': 'Extra cost cannot be computed: no usage returned', 'no-ref': 'Extra cost cannot be computed',
})
export const CACHE_SEMANTICS_UNKNOWN = 'What this provider\'s cache numbers mean is not certain'
export const JUMP_TO_CHANGE = 'Jump to the change ›'

// ── the 组成 popover ──────────────────────────────────────────────────────────────────────────────────────────────────
export const SEG_NAME = Object.freeze({ tools: 'tool definitions', system: 'system prompt', history: 'earlier messages', task: 'new in this step' })
export const COMP_CALIBRE = 'By content bytes, without the request\'s JSON wrapper; tokens are estimated from characters'
export const compCulprit = (seg, pct) => `Largest part: ${SEG_NAME[seg] || seg} (${pct}%), resent with every request`
export const TOOLS_ESTIMATED = 'Tool definitions were stored as metadata only; the size of this part is an estimate'
export const DIAGNOSE_ONLY = 'This only says where the growth comes from; whether to cut anything is up to the agent'
export const COMPACTION_REWRITE = 'Compaction: the whole context was rewritten, not appended block by block'
export const compOffPage = (n) => `The content of step ${n} is not on the current page, so the growth cannot be computed`
export const COMP_SELF = Object.freeze({ paged: 'This step\'s content is not on the current page, so the breakdown cannot be computed', unparsed: 'This step\'s request could not be parsed', none: 'No request was captured for this step' })
export const compSize = (n) => `Content of this request: ${n}`
export const growthLine = (delta, segW, less = false) => `${delta} ${less ? 'less' : 'more'} than the previous step` + (segW ? `, mostly in ${segW}` : '')
export const growthVs = (n, delta, segW, less = false) => `${delta} ${less ? 'less' : 'more'} than step ${n}` + (segW ? `, mostly in ${segW}` : '')
export const LOAD_STEP = (n) => `Load step ${n}`

// ── the ≈ $ popover ───────────────────────────────────────────────────────────────────────────────────────────────────
export const COST_CALIBRE = 'Local estimate (usage × unit price), not a bill'
export const PRICE_BY_KEY = (key) => `At the unit price of ${key}`
export const SEE_PRICES = 'Unit prices ›'
export const COST_WHY = Object.freeze({
  failed: 'The call failed; no cost', 'no-usage': 'No usage returned; no cost', 'no-price': 'No unit price for this model',
})
export const priceTableNote = (table, err) => (table ? '' : err ? `The price table could not be read: ${err}` : 'Loading the price table')

// ── the compare menu (2.3 §两个对比步; the control itself is 2.2's) ────────────────────────────────────────────────────
export const COMPARE = 'Compare'
export const compareAt = (n) => `Comparing with step ${n} ×`
export const COMPARE_DEFAULT = 'Previous step (default)'
export const compareDefaultAt = (n) => `Step ${n} (default)`
export const COMPARE_PICK = 'Pick a step…'
export const COMPARE_WITH = 'Compare with step'
export const COMPARE_WITH2 = ''
export const COMPARE_OK = 'OK'
export const COMPARE_RANGE = (m) => `Between 1 and ${m}, and not the current step`

// ── the three buttons and their popovers (the button word carries the short state; the rest is behind it) ────────────
export const CACHE_TITLE = 'Cache'
export const CACHE_POPOVER_LABEL = 'Cache at this step'
export const COMP_TITLE = 'Breakdown'
export const COMP_POPOVER_LABEL = 'What this request is made of'
export const COMP_BTN = 'Breakdown'
export const COMP_BTN_NONE = 'Breakdown —'
export const COST_TITLE = '≈ $'
export const COST_POPOVER_LABEL = 'Estimated cost of this step'
export const CMP_RESET = 'Back to the previous step'

// ── the step head (2.2 §步头) ─────────────────────────────────────────────────────────────────────────────────────────
export const STEP_PREV = 'Previous step'
export const STEP_NEXT = 'Next step'
export const stepNo = (n, m) => `Step ${n} / ${m}`
export const callNo = (laneW, k, m) => `${laneW} · call ${k} / ${m}`
export const askNo = (k) => `Prompt ${k}`

// ── the session head (1.2 §会话头) ────────────────────────────────────────────────────────────────────────────────────
export const BACK = '‹ Sessions'
export const UNTITLED = 'Untitled session'
export const FOLLOW = 'Follow latest'
export const SESSION_INFO_LABEL = 'About this session'
export const MULTIPLE_AGENTS = 'several agents'
export const TITLE_FROM_META = 'The title comes from the agent\'s own records, not from captured content'
export const TITLE_FROM_PROMPT = 'Taken from the first prompt'
export const TITLE_UNTITLED_TIP = 'No usable title; the start time comes from the record of the first step'
export const MULTIPLE_AGENTS_TIP = 'Records of several agents share this session id'
export const PROJECT = 'project'
export const GUESS = 'inferred'

// ── the 会话保真行 (1.2 §会话保真行): each fact's plain words ────────────────────────────────────────────────────────
export const truncFact = (shown, total, fileMb) => `Showing only the latest ${shown} / ${total} calls (file ${fileMb} MB)`
export const unknownFact = (n) => `${n} records no parser can read; not drawn`
export const LOGGED_FACT = 'calls are log only and not in the replay ›'
export const loggedFact = (n) => `${n} ${LOGGED_FACT}`
export const FILES_FACT = 'capture files were not read in full; this session may be missing content ›'
export const filesFact = (n) => `${n} ${FILES_FACT}`
export const GAP_FACT = 'Capture had errors in this period; calls may be missing from the range read (inferred) · capture log ›'

// ── the context window (2.3): sections, block marks, the 调用保真行, the 窗口行, the 变化线, the代替态 ────────────────
export const SECTION_NAME = Object.freeze({ tools: 'Tool definitions', system: 'System prompt', messages: 'Messages' })
export const SECTION_VERBATIM = 'verbatim below'
export const SECTION_SIZE_TIP = 'The sum of the content bytes of the blocks in this section'
export const SECTION_SIZE_EST = '≈'
export const SECTION_SIZE_EST_TIP = 'Tool definitions were stored as metadata only; the size is an estimate'
export const HALF_MARK = '◐'
export const WINDOW_LINE = 'This step\'s content cannot be traced back to the raw bytes (it was parsed again)'
export const FOLD_ALL_OPEN = 'Expand all'
export const FOLD_ALL_CLOSE = 'Collapse all'
export const FOLD_ALL_OPEN_TIP = 'Expand every prompt card in this step'
export const FOLD_ALL_CLOSE_TIP = 'Collapse every prompt card in this step'

// the 调用保真行 (2.3): one fact per field, joined by 「 · 」; the closed sets of contextState and the three *Incomplete flags
export const CTX_FACT = Object.freeze({
  partial: 'Context incomplete: earlier records are missing', partialBare: 'Context incomplete', unknownWhy: 'cause unknown',
  reconstructed: 'reconstructed from earlier records', server_edited: 'the server edited the context; this is not everything the model received',
  fallback: 'the context was not fully captured',
})
export const REQ_FACT = Object.freeze({ truncated: 'truncated at the capture limit', partial: 'incomplete' })
export const WS_FACT = Object.freeze({ partial: 'earlier messages on this connection are missing', truncated: 'some messages were over the limit; length only', undecoded: 'some messages were not decompressed', nonVerbatim: 'some messages are length only' })
export const RESP_FACT = Object.freeze({ undecoded: 'not decompressed', binary: 'not text', notJson: 'not JSON', empty: 'no response body', unparsed: 'some events could not be parsed; the reply may be incomplete', truncated: 'truncated at the capture limit' })
export const INCOMPLETE_WORD = Object.freeze({ req: 'request', ws: 'messages', resp: 'reply' })
export const reqEncodingFact = (enc) => `The request body was compressed on the wire (${enc}); this is the exact decompressed text`

// block-level marks (2.3 §保真标): one visible word per unproven block; the codes are the 3.2 closed set plus
// asight's own opened-body outcomes (notfetched · reserialized · unknown)
export const FF_WORD = Object.freeze({
  metadata: 'metadata only', opaque: 'encrypted; no plaintext', summarized: 'a client summary, not the original', omitted: 'omitted by the source',
  truncated: 'truncated at the source', unaddressable: 'not addressable', unknown: 'fidelity unknown', notfetched: 'bytes could not be fetched',
  reserialized: 'reserialized, not the wire bytes', verbatim: 'verbatim',
})
export const FF_TIP = Object.freeze({
  metadata: 'Metadata only: the full JSON schema was not captured (an older capture); the model received the full schema',
  opaque: 'Encrypted / redacted reasoning: the wire carries only a signature or ciphertext; there is no plaintext to restore',
  summarized: 'A client summary replaced the original (for example in compaction); this is not the verbatim original',
  omitted: 'The source omitted the content of this block',
  truncated: 'The source itself was not captured in full (truncated at the capture limit); the full text is not on disk',
  unaddressable: 'Not addressable: this block has no locatable byte span on the wire; its text came inline with the block',
  unknown: 'Fidelity unknown: the server gave a fidelity value outside the known set; it is not treated as verbatim',
  notfetched: 'Bytes could not be fetched: reading the source failed, the reason is in the body; opening it again retries',
  reserialized: 'These bytes were reserialized on their way into the capture; they are not a verbatim record of the wire bytes',
  verbatim: 'Verbatim: what is stored for this block is the wire bytes, unchanged',
})
export const INLINE_NOTE = 'This text came inline with the block; it is not cut verbatim from the raw capture'
export const NO_BODY = 'This block has no body and no source location'
export const FETCHING = 'Fetching…'
export const clipNote = (n) => `…(${n} characters in total; only the first 20000 are shown)`
// the raw panel's reply / the drawer's reply: the display clip said once, in 2.6 §A's own words (the context window's
// blocks keep clipNote above — 2.3 K-07 pins that wording for them)
export const clipShownNote = (shown, total) => `Display truncated · first ${shown} of ${total} characters`

// block-head words (2.3 §block 卡)
export const CACHE_MARK = 'cache mark'
export const CACHE_MARK_TIP = 'The request declares a cache position at this block; how the cache treats this mark differs by provider'
export const VOLATILE_MARK = 'changes every call — not part of the cache key'
export const VOLATILE_MARK_TIP = 'The bytes of this block change on every call but are left out of the cache key, so they do not affect cache hits'
export const NEW_MARK = 'new'
export const NEW_MARK_TIP = 'This block is not in the compared step: content new to the context at this step (part of the resent growth)'
export const CHARS_WORD = 'characters'
// head.tag's closed set in plain words (2.3 Edge「块头 tag 的中文」); a data suffix (a tool name, MCP) rides along
export const TAG_WORD = Object.freeze({
  def: 'instructions', user: 'message', say: 'message', text: 'message', 'system-reminder': 'system reminder', thinking: 'thinking',
  observation: 'tool result', image: 'image', document: 'document',
})
export const TAG_ACTION = 'tool call'
export const TAG_ERROR = 'error'
export const TAG_UNKNOWN = 'unknown'

// the 变化线 (2.3 §变化线)
export const STRUCT_EST_WORD = 'structural estimate'
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
