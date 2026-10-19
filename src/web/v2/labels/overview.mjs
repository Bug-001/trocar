// labels/overview.mjs — the words of the overview page (1.7): the cards' names, the capture card's fixed parts, every
// 事项 sentence, the stats figures, the disk and first-run cards. Fixed text only — keyed by asight's own closed sets
// (windows, condition kinds, source names), never by a harness-defined code (those carry their own words from the
// server, 1.5 §数据规则). The capture card's state sentence itself is NOT here: it is core/capture-verdict.mjs's, so
// the capture card and the 采集 page cannot say two things (1.7 §采集卡).
import { MARK_TIP } from './common.mjs'

export const CARD = Object.freeze({ capture: 'Capture', items: 'Needs a look', stats: 'Stats', recent: 'Recent sessions', disk: 'Disk', start: 'Get started' })

// the stats window of the page head (1.7 §统计窗): three fixed choices, the route's `window` param
export const WINDOWS = Object.freeze(['24h', '7d', 'all'])
export const WINDOW_LABEL = Object.freeze({ '24h': '24 hours', '7d': '7 days', all: 'All' })

export const GO_CAPTURE = 'Capture ›'
export const READ_FILES_FAIL = (n) => `${n} record file${n === 1 ? '' : 's'} could not be read`
export const AGENTS_ON = (on, total) => `${on} / ${total} agents on`

// ── 要处理的事 ─────────────────────────────────────────────────────────────────────────────────────────────────────
// the caption row of the items card. The window the failure groups cover is the health read's own (read.window_hours).
export const FAIL_LIST = 'Failure list'
export const FAIL_WINDOW = (h) => `Only the last ${h} hours are listed`
export const NO_ITEMS = 'Nothing needs a look'
// which sources this round could not read (1.7 事项目录 · 不全说明): 「采集状态、价表没读到,下面可能不全」
export const SRC_NAME = Object.freeze({ health: 'capture health', projects: 'session list', retention: 'retention', pricing: 'price table', usage: 'stats', traffic: 'traffic' })
export const PARTIAL_NOTE = (names) => `${names.join(', ')} could not be read; the list below may be incomplete`
export const CAP_STALE_AS_OF = (t) => `capture health as of ${t}`
export const MORE_OF = (n) => `${n} more ›`

// O1 / O1′ — a condition that still holds. The sentence prefers the daemon's own `reason` (it says what to do about
// it); the kind words below are the fallback for a condition that carries none. These kinds are asight's own closed
// set (src/health/flows.mjs foldFlows), so they may be keyed here; the 采集 page (1.9) words the same kinds for its own
// rows and should adopt these words when it lands (labels-complete reconciles the two).
export const KIND_WORD = Object.freeze({
  untrusted: "not on capture's trust list",
  'negative-cache': "refused asight's certificate; not captured for now",
  degraded: 'the capture helper is missing; capture is degraded',
  'helper-version': 'the capture helper is the wrong version',
  'state-mismatch': 'the wanted on / off does not match the actual state',
  'ca-invalid': "asight's certificate cannot be used",
})
// [待 #45] the one code whose meaning is 「asight 挡住了它的网络」(1.6 §9.6): its item says so
export const NET_BLOCKED_CODE = 'forwarder-down'
export const NET_BLOCKED = (why) => `may not reach the network now: ${why}`
export const NOT_CAPTURED = 'not capturing now'
export const AGENT_ITEM = (name, why) => `${name}: ${why}`
export const ETC_K = (k) => ` and ${k} more`
export const AS_OF_TAIL = (t) => ` (as of ${t})`
export const SVC_ITEM = (why) => `capture service: ${why}`

// O3 — a failure group of the last 24 h. The sentence itself is the group's own reason (the server's words); the key
// rides in 技术细节 until labels/capture.mjs (1.9) words the closed set of codes.
export const FAILURES = 'Capture failures'
export const RAW_FAILURES = 'Sealing or reading failed'
export const FAIL_TIMES = (n) => `×${n}`
export const SVC_SUBJECT = 'Capture service'

// O4 / O5 — the last install's notes, what an uninstall could not undo
export const INSTALL_NOTES = (n) => `the last install left ${n} note${n === 1 ? '' : 's'}`
export const INSTALL_FAILED = 'the last install failed'
export const UNINSTALL_NOTES = (n) => `the last uninstall left ${n} note${n === 1 ? '' : 's'}`
export const UNINSTALL_FAILED = 'the last uninstall failed'
export const MANIFEST_ERROR = 'the install manifest could not be read'
export const RESIDUE_UNFINISHED = (n) => `the install did not finish; ${n} item${n === 1 ? '' : 's'} left`
export const RESIDUE_LEFT = (n) => `${n} item${n === 1 ? '' : 's'} left behind by the uninstall`

// O6 — files that could not be read whole
export const FILES_NOT_READ = (n) => `${n} capture file${n === 1 ? ' was' : 's were'} not read in full`

// O8 / O9 — models without a price; a host seen for the first time
export const UNPRICED = (n) => `${n} model${n === 1 ? ' has' : 's have'} no unit price`
export const NO_MODEL_NAME = 'no model name'
export const NEW_HOST = (name, host) => `${name} reached ${host} for the first time`
export const BY_STATS = 'inferred from the records already in the stats'

// ── 统计 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const AS_OF = (t) => `as of ${t}`
export const SCOPE_LINE = 'counts sessions last active in this window, each session in full'
export const COVERAGE = (names) => `excludes ${names}: their sessions are not in the library yet`
export const SESSIONS_N = (n) => `${n} session${n === 1 ? '' : 's'}`
export const CALLS_N = (n) => `${n} model call${n === 1 ? '' : 's'}`
export const COST_APPROX = '$'
export const FROM = 'from'
export const CANT = 'cannot be computed'
export const HIT_PCT = (p) => `main thread cache hit ${p}%`
export const HIT_LABEL = 'main thread cache hit'
export const HIT_UNKNOWN_TIP = "this provider's cache figures have an uncertain meaning"
export const BREAKS_N = (n) => `${n} cache break${n === 1 ? '' : 's'}`
export const EXTRA_LABEL = '≈ extra cost'
export const WASTED_CANT_K = (k) => `${k} cannot be computed`
export const WASTED_WHY = Object.freeze({
  'no-ref': 'no earlier call to compare with', 'no-usage': 'this row has no usage', 'no-write-counter': 'the reference call reported no cache write', 'no-price': "no unit price for this row's model",
})
export const MOST_EXPENSIVE = 'Most expensive session ›'
export const EST_TIP = 'local estimated cost (usage × unit price), not a bill'
export const EMPTY_WINDOW = 'no sessions in this window'
export const PRICE_FAIL = (why) => `the price table could not be read: ${why}`
export const TBL = Object.freeze({ agent: 'agent', sessions: 'sessions', calls: 'model calls', cost: '≈ cost', hit: 'main thread cache hit', breaks: 'cache breaks', last: 'last active' })

// ── 最近的会话 · 磁盘 · 开始使用 ───────────────────────────────────────────────────────────────────────────────────
export const ALL_SESSIONS = 'All sessions ›'
export const UNNAMED = (t) => `untitled session · last active ${t}`
export const PROBE_ONLY = 'token counts only'
export const PROBE_ONLY_TIP = 'this session has only token-count calls, no full content'
export const FROM_FIRST_PROMPT = 'taken from the first prompt'
export const TITLE_FROM_AGENT = "title from the agent's own record"
export const READ_FAIL = (what, why) => `${what} could not be read: ${why}`
export const RETRY = 'Retry'
export const DISK_USE = (b) => `${b} used by asight`
export const DISK_AT_LEAST = (b) => `at least ${b} used by asight`
export const DISK_PER_DAY = (b) => `grows ≈ ${b} a day`
export const DISK_STALE = 'the newest call in the library is more than 24 hours old'
export const SEE_STORAGE = 'Storage ›'
export const START_ROWS = Object.freeze([
  ['What it records', "Every call an agent sends to a model is recorded in full, with the model's response and usage, along with the agent's other network requests."],
  ['Where it is kept', 'These records are kept on this computer only.'],
  ['What happens next', "Once installed, the first record appears here by itself the next time an agent calls a model. asight never sends a request for you."],
])
export { MARK_TIP }
