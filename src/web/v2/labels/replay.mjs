// labels/replay.mjs — the words of the replay desk (回放台): the session head, the 会话保真行 and the session info popover
// (1.2 §会话头), the step head and its 缓存 / 组成 / ≈ $ popovers and the compare menu (2.2 §步头), the lane kind table's words
// (2.1, owned here for the whole board). Fixed text keyed by trocar's own closed sets — the cache-predicate states
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
export const COMP_SELF = Object.freeze({ unparsed: 'This step\'s request could not be parsed', none: 'No request was captured for this step' })
export const compSize = (n) => `Content of this request: ${n}`
export const growthLine = (delta, segW, less = false) => `${delta} ${less ? 'less' : 'more'} than the previous step` + (segW ? `, mostly in ${segW}` : '')
export const growthVs = (n, delta, segW, less = false) => `${delta} ${less ? 'less' : 'more'} than step ${n}` + (segW ? `, mostly in ${segW}` : '')

// ── the ≈ $ popover ───────────────────────────────────────────────────────────────────────────────────────────────────
export const COST_CALIBRE = 'Local estimate (usage × unit price), not a bill'
export const PRICE_BY_KEY = (key) => `At the unit price of ${key}`
export const SEE_PRICES = 'Unit prices ›'
export const COST_WHY = Object.freeze({
  failed: 'The call failed; no cost', 'no-usage': 'No usage returned; no cost', 'no-price': 'No unit price for this model',
})

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
export const TITLE_FROM_WIRE = 'The title is taken from the captured requests'
export const TITLE_UNTITLED_TIP = 'No usable title; the start time comes from the record of the first step'
export const MULTIPLE_AGENTS_TIP = 'Records of several agents share this session id'
export const PROJECT = 'project'
export const GUESS = 'inferred'

// one plural rule for every count label: count(1, 'call') → '1 call', count(2, 'call') → '2 calls'
export const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`

// ── the 会话保真行 (1.2 §会话保真行): each fact's plain words ────────────────────────────────────────────────────────
export const truncFact = (shown, total, fileMb) => `Showing only the latest ${shown} / ${total} calls (file ${fileMb} MB)`
export const unknownFact = (n) => `${n} records no parser can read; not drawn`
export const LOGGED_FACT = 'calls are log only and not in the replay ›'
export const loggedFact = (n) => `${n} ${LOGGED_FACT}`
export const filesFact = (n) => `${count(n, 'capture file was', 'capture files were')} not read in full; this session may be missing content ›`
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
// trocar's own opened-body outcomes (notfetched · reserialized · unknown)
export const FF_WORD = Object.freeze({
  metadata: 'metadata only', opaque: 'encrypted; no plaintext', summarized: 'a client summary, not the original', omitted: 'omitted by the source',
  truncated: 'truncated at the source', unaddressable: 'not addressable', unknown: 'fidelity unknown', notfetched: 'bytes could not be fetched',
  reserialized: 'reserialized, not the wire bytes', verbatim: 'verbatim', parsed: 'parsed reply',
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
export const changeLine = (k, causeW) => (k != null ? `Differs from step ${k} from here · ${causeW}` : `Changes from here · ${causeW}`)
export const CHANGE_COMPACT = 'Compaction: everything below was rewritten'
export const CHANGE_COMPACT_INFERRED = 'inferred'
export const CHANGE_REF_HINT = 'A structural reference, not the real boundary'
export const changeFirstTip = (headW) => `First differing block: ${headW}`
export const removedList = (n, k2) => `Blocks in step ${k2} that are not in this step: ${n}`

// the 代替态 (1.4 ⑤–⑧, words 2.3)
export const RETRY = 'Retry'
// what a failed read of the desk names (1.5 K-29, core/ui.mjs readFailure): the never-drawn failure and the stale line
export const THIS_SESSION = 'This session'
export const notRefreshed = (t, why) => `Not refreshed since ${t} · ${why}`
// 1.2 §会话头 读取状态: the server is still extracting this session (first read: share done; later: calls still to catch up)
export const readingFirst = (pct) => `Reading this session for the first time · ${pct} %`
export const catchingUp = (n) => `Catching up · ${n} new calls`
// 1.5 K-31: the server's background read of this session stopped (the head's pending.stopped), one line per code of
// src/health/codes.mjs FOLD_STOPS (the board does not import it); the code and the reason are in the technical details
export const FOLD_STOPPED = Object.freeze({
  'heap-no-room': 'Reading this session stopped: it does not fit in the memory the reader has',
  'fold-failed': 'Reading this session stopped on an error',
})
// 1.5 K-32: the head drawn is older than what the capture has indexed
export const behindBy = (n, more) => `${n}${more ? '+' : ''} newer calls are not shown yet`
// 2.3 §大致页面: the lanes the session head does not list by name
export const moreLanes = (n) => `${n} more lanes`
export const FOLLOW_PAUSED = 'Following is paused: the last read failed'
export const UNPARSED_TITLE = 'This step\'s request could not be parsed; there is no context to show'
export const UNPARSED_KEEP = 'The raw record is on disk, unchanged'
export const NO_REQUEST = 'No request was captured for this step'

// ── the session info popover (1.2 §信息弹出层, the rows in order) ────────────────────────────────────────────────────
export const COST_LINE = '≈ cost'
export const BUCKETS = Object.freeze({ main: 'main thread', sub: 'sub-agents', bg: 'background calls' })
export const COST_FROM = 'from'
export const noPriceCalls = (n) => `${count(n, 'model call has', 'model calls have')} no unit price`
export const NO_ANY_PRICE = 'No unit price for these models'
export const HIT_LINE = 'Main thread cache hit'
export const HIT_MAIN_ONLY = 'main thread only'
export const HIT_UNMEASURED = 'cannot be computed (no usage returned)'
export const BREAKS_LINE = (n) => `${count(n, 'cache break')} (${L.STRUCT_EST})`
export const BREAK_COST_LINE = '≈ extra cost'
export const BREAK_COST_SOME = (n) => `${n} of them cannot be computed`
export const WORST_AT = (n) => `Most expensive at step ${n} ›`
export const FAILED_LINE = (n) => `${count(n, 'failed call')} ›`
export const COMPACTION_LINE = (n) => `${n} compactions`
export const COUNTS_LINE = { sub: (n) => count(n, 'sub-agent'), bg: (n) => count(n, 'background call'), probe: (n) => count(n, 'token count') }
export const START_LINE = 'Started'
export const DURATION_WORD = 'Duration'
export const SESSION_ID = 'Session id'
export const COPY = 'Copy'
export const TRUNCATED_NOTE = (shown) => `Counts only the ${count(shown, 'call')} shown`
export const MODEL_CALLS = (n) => count(n, 'model call')

// ── the trace (1.3): the problem lane, the cache band's four states, the view switch, the overlay rows ───────────────
export const PROBLEM_ROW = 'Problems'
export const problemPager = (k, n) => (!n ? 'Problems' : k == null ? count(n, 'problem') : `Problem ${k}/${n}`)
export const PROBLEM_PREV = 'Previous problem'
export const PROBLEM_NEXT = 'Next problem'
// the chapter row (1.3 §章): the part of the session between two compactions, and the arrows across them
export const CHAPTER_PREV = 'Previous compaction'
export const CHAPTER_NEXT = 'Next compaction'
export const chapterLabel = (k, n, a, b, inferred) => `Part ${k} of ${n} · ${a === b ? `step ${a}` : `steps ${a}–${b}`}${inferred ? ' (inferred)' : ''}`
export const breakFlagTip = (n, costW, struct) => `Cache break at step ${n} · ${costW}` + (struct ? ` · ${L.STRUCT_EST}` : '')
export const BREAK_COST_NONE = 'extra cost cannot be computed'
export const failTip = (n, msg) => `Call failed at step ${n}${msg ? ` (${msg})` : ''}`
export const COMPACT_WORD = 'compaction'
export const compactTip = (n, inferred) => `Compaction at step ${n}: the history was rewritten and the whole context written again${inferred ? ' (inferred)' : ''}`
// the cache band's four hover shapes, in the predicate's own order
export const CACHE_CELL_FAILED = 'cache failed'
export const CACHE_CELL_NONE = 'cache —'
export const CACHE_CELL_NONE_TIP = 'No usage returned, so this cannot be computed (not 0%)'
export const cacheCellPct = (p) => `cache ${p}%`
export const cacheCellUnknown = (p) => `cache ${p}%?`
export const CACHE_LEGEND = 'high = hit, middle = partial, low = none, dashed = no usage'
export const CACHE_LEGEND_UNK = 'meaning not certain'
export const VIEW_CTX = 'Context size'
export const VIEW_COST = 'Cost'
export const COMP_LEGEND = 'colour = content type (estimated from content size)'
export const COST_LEGEND = 'bar height = estimated cost of the step (usage × unit price) · hatched = cannot be computed'
export const showSteps = (a, b) => (a === b ? `Showing step ${a}` : `Showing steps ${a}–${b}`)
export const noMainLane = (laneW) => `This session has no main thread; the timeline follows the ${laneW} calls`
export const ONLY_MAIN = 'This session has only the main thread'
export const peakCtx = (v) => `${v} tok` // kf() bakes the number; the peak is the main lane's real total_input
export const askScaleTip = (k, preview) => `Prompt ${k}` + (preview ? ` ${preview}` : '')
// an ask tick whose held event is not there yet names only its step (a stepRef(); nothing when the step is not known)
export const askScaleStepTip = (ref) => (ref && ref.step ? `Step ${ref.n}` : '')
// the overlay rows' names (2.1 / 1.3): the counts are the full truth, never the drawn ticks
export const SUBAGENT_ROW = (n) => count(n, 'sub-agent')
export const BG_ROW = (n) => count(n, 'background call')
export const TC_ROW = (n) => count(n, 'token count')
export const laneTimes = (word, n) => `${word} · ${count(n, 'call')}`
export const callsWord = (n) => count(n, 'call')
export const TC_SAMPLED_TIP = (m, n) => `${m} of ${n} drawn; clicking anywhere opens the nearest one`
export const TC_NO_SIZE = (j) => `${j} of them returned no size and are not drawn`
export const FLAGGED_WORD = 'flagged a problem' // S13 landed: flagged === true draws a mark on the collapsed 后台调用 row
export const REVIEW_TIP = (k) => `Inferred from timing: when this call was sent, the main thread was at step ${k}`

// ── the outline (2.5) ────────────────────────────────────────────────────────────────────────────────────────────────
export const OUTLINE_HEAD = 'Input of this step'
export const GRP_TOOLS = 'Tool definitions'
export const GRP_SYS = 'System prompt'
export const GRP_ASK = 'Prompts'
export const NO_TOOLS = 'No tool definitions in this step'
export const NO_SYS = 'No system prompt in this step'
export const NO_ASK = 'No recognisable prompt in the context of this step'
export const MCP_WORD = 'MCP'
export const askSince = (n) => `from step ${n}`
export const QUERY_GUESS_TIP = 'Whether a person wrote this prompt is inferred'
export const UNPARSED_LINE = 'The request body could not be parsed'

// ── the resource explorer (2.4) ──────────────────────────────────────────────────────────────────────────────────────
export const RES_SECTION = 'Resources · whole session'
export const RES_GRP = Object.freeze({
  file: 'Files read', seen: 'Names seen only', load: 'Instruction files loaded', cap: 'Tools and capabilities', dl: 'Directories and links', comp: 'Compaction', other: 'Other resources',
})
export const OTHERS_ROW = (n) => `${n} more`
// the lifecycle words take the composed step word (「step 5」, or 「call 5」 when the session has no main lane)
export const lifeIn = (at) => `read at ${at}`
export const LIFE_IN_CTX = 'in context'
export const lifeEvicted = (at) => `removed by compaction at ${at}`
export const lifeLoaded = (at) => `loaded at ${at}`
export const lifeSeen = (at) => `seen at ${at}`
export const seenTip = (k, at) => `Seen ${k} times · first at ${at}`
export const SEEN_GROUP_TIP = 'Names picked from tool results and text because they look like paths; some may be missed and some may be wrong. The agent never opened them, so there is no content here. At most 200 are listed'
export const SHOW_ALL = (n) => `Show all ${n}`
export const HIDE_ALL = 'Show fewer'
export const NO_LEDGER = 'This agent\'s records have no resource information'
export const NO_RESOURCES = 'No resource records (this agent may not provide them)'
export const DIR_WORD = 'directory'
export const LINK_WORD = 'link'
export const compactRow = (at, from, to) => `${at} · compaction: ${from} → ${to} messages`
export const summarizeRow = (at, out) => `${at} · summary (${out} output tokens)`
export const ONLY_CALLS = 'call seen only'
export const ONLY_CALLS_TIP = 'The call was seen; the resident content is not in the captured context'
export const viewNameTip = (name) => `View the content of ${name}`
export const jumpStepTip = (at) => `Jump to ${at}`
// the capability's two tiers, by 2.3's proof rule
export const CAP_VERBATIM = 'Tool definitions were captured verbatim; expand the tool block in the context window to see the full schema'
export const TOOL_METADATA_ONLY = 'Metadata only: the full JSON schema (parameter types / required / enums / nesting) and the description text were not captured. The model received the full schema; this is a capture boundary, not a display clip.'
export const CAP_METADATA = 'Metadata only: name, parameter count, description length; not the verbatim schema'
export const CAP_MIXED = 'These tool definitions are not all proven to match the wire; each tool block in the context window carries its own mark'
export const capToolRow = (name, chars) => `${name} · ${chars} characters`
// the pinned panel's honest fallbacks
export const RES_NOT_FOUND = 'No single matching block in the context of this step: it may have been read earlier or already removed. Click the step number on this row to jump to the step that read it.'

// ── the raw panel (2.6 §A) ───────────────────────────────────────────────────────────────────────────────────────────
export const RAW_WORD = 'Raw'
export const RAW_HEAD = (n) => `Raw · step ${n}`
export const REPLY_WORD = 'Reply'
export const THINKING_ROW = 'Thinking'
export const toolCallRow = (name) => `Tool call ${name}`
export const stopReasonRow = (v) => `Stop reason ${v}`
export const REPLY_PARSED = FF_WORD.parsed
export const REPLY_PARTIAL = 'reply incomplete'
export const RAW_REPLY = 'Raw reply'
export const rawReplyRow = (chars) => `Raw reply · ${chars} characters ›`
export const rawReplyNth = (k) => `Raw reply ${k}`
export const NO_RAW_REPLY = 'The raw reply has no bytes to read back'
export const REQ_PARAMS = 'Request parameters'
export const NO_PARAMS = 'This record has no request parameters to read back'
export const UNPARSED_PARAMS = 'The request body could not be parsed, so no parameters can be listed'
export const EXTRA_MSGS = (n) => `Messages the client sent later in this call · ${n} ›`
export const TRANSPORT_HTTP = 'Transport HTTP'
export const TRANSPORT_WS = 'Transport WebSocket'
export const VENDOR_WORD = 'Vendor'
export const BACK_TO_RAW = 'Back to raw'
export const FAILED_NO_REPLY = 'This call failed; there is no reply'
export const EMPTY_REPLY = 'The reply has no content'
export const UNREAD_REPLY = 'No part of the reply could be read'
export const TECH_DETAILS = 'Technical details'

// ── the call drawer (2.6 §B) ────────────────────────────────────────────────────────────────────────────────────────
export const DRAWER_CLOSE = 'Close'
export const backToStep = (n) => `← Back to step ${n}`
export const inputBlocks = (n) => `Input · ${n} blocks`
export const NO_INPUT = 'This call has no input blocks'
export const INPUT_NOT_PAGE = 'The input of this call is not on the current page'
export const VERBATIM_FOLD = (n, unit) => `verbatim · ${n} ${unit} · open`
export const foldAt = (word, n, unit) => `${word} · ${n} ${unit} · open`
export const TC_INPUT = Object.freeze({
  full: 'The request body is not in the session; see each one on the traffic page under the "token-count" class (retention: full)',
  log: 'The request body is not in the session; see each one on the traffic page under the "token-count" class (retention: log only)',
  old: 'The request body is not in the session; see each one on the traffic page under the "token-count" class (retention: an older capture, length only)',
})
export const TC_MEASURED = (n) => `Measured ${n} tokens`
export const OPAQUE_ROW = 'opaque — only a signature on the wire, no plaintext'

// ── the `?` key list (1.2 §键盘) ──────────────────────────────────────────────────────────────────────────────────────
export const KEYS_TITLE = 'Keyboard'
export const BRUSH_LABEL = 'Steps shown above (the arrow keys move the step)'
export const KEY_LIST = Object.freeze([
  ['← / →', 'Previous / next step'],
  ['Shift + ← / →', 'Ten steps back / forward'],
  ['Home / End', 'First / last step'],
  ['n / p', 'Next / previous step with a problem'],
  ['[ / ]', 'Back / forward across a compaction'],
  ['f', 'Follow the latest step on or off'],
  ['Esc', 'Close the topmost layer'],
  ['?', 'This list'],
])
