// labels/overview.mjs — the words of the overview page (1.7): the cards' names, the capture card's fixed parts, every
// 事项 sentence, the stats figures, the disk footer and the first-run card. Fixed text only — keyed by asight's own closed sets
// (windows, condition kinds, source names), never by a harness-defined code (those carry their own words from the
// server, 1.5 §数据规则). The capture card's state sentence itself is NOT here: it is core/capture-verdict.mjs's, so
// the capture card and the 采集 page cannot say two things (1.7 §采集卡).
import { MARK_TIP } from './common.mjs'

export const CARD = Object.freeze({ capture: 'Capture', items: 'Needs a look', stats: 'Stats', recent: 'Recent sessions', start: 'Get started', agents: 'Agents' })

// the stats window of the page head (1.7 §统计窗): three fixed choices, the route's `window` param
export const WINDOWS = Object.freeze(['24h', '7d', 'all'])
export const WINDOW_LABEL = Object.freeze({ '24h': '24 hours', '7d': '7 days', all: 'All' })

export const GO_CAPTURE = 'Capture ›'
export const READ_FILES_FAIL = (n) => `${n} record file${n === 1 ? '' : 's'} could not be read`
export const AGENTS_ON = (on, total) => `${on} / ${total} agents on`

// ── 要处理的事 ─────────────────────────────────────────────────────────────────────────────────────────────────────
// the caption row of the items card: the failure groups cover the last 24 h (`status` failures.since)
export const FAIL_LIST = 'Failure list'
export const FAIL_WINDOW = (since) => `Only the last 24 hours are listed${since ? ` (since ${since})` : ''}`
export const NO_ITEMS = 'Nothing needs a look'
// which sources this round could not read (1.7 事项目录 · 不全说明): 「采集状态、价表没读到,下面可能不全」
export const SRC_NAME = Object.freeze({ health: 'capture health', sessions: 'session list', classes: 'storage', pricing: 'price table', stats: 'stats', traffic: 'traffic', segments: 'raw segments' })
export const PARTIAL_NOTE = (names) => `${names.join(', ')} could not be read; the list below may be incomplete`
export const CAP_STALE_AS_OF = (t) => `capture health as of ${t}`
export const MORE_OF = (n) => `${n} more ›`

// O1 / O1′ — an agent's row sentence is the 采集 page's (core/capture-verdict.mjs agentVerdicts); a service-level condition
// prefers its own `reason`, then the CLI's catalog (src/cli/words.mjs failureWord)
export const SVC_ITEM = (why) => `capture service: ${why}`
// O2 — the capture service's state cannot be said; `why` is daemon.error as the server wrote it
export const UNKNOWN_ITEM = (why) => `capture service state unknown: ${why}`

// O3 — a problem-level failure group of the last 24 h; its sentence is the capture log's (failureSentence)
export const FAILURES = 'Capture failures'
export const FAIL_TIMES = (n) => `×${n}`
export const SVC_SUBJECT = 'Capture service'
export const RAW_SUBJECT = 'Sealing or reading failed'

// O4 / O5 — the last install did not finish, left items, or its record cannot be read
export const INSTALL_UNFINISHED = 'the last install did not finish'
export const MANIFEST_ERROR = 'the install manifest could not be read'
export const RESIDUE_UNFINISHED = (n) => `the install did not finish; ${n} item${n === 1 ? '' : 's'} left`
export const INSTALL_PENDING = (n) => `the last install has ${n} item${n === 1 ? '' : 's'} to look at`
export const RESIDUE_LEFT = (n) => `${n} item${n === 1 ? '' : 's'} left behind by the uninstall`

// O6 — files that could not be read whole
export const FILES_NOT_READ = (n) => `${n} capture file${n === 1 ? ' was' : 's were'} not read in full`

// O9 — a host seen for the first time
export const NEW_HOST = (host) => `reached ${host} for the first time` // after the agent chip: the chip names the agent (1.7)
export const BY_STATS = 'inferred from the records already in the stats'

// ── 统计 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const AS_OF = (t) => `as of ${t}`
export const SCOPE_LINE = 'counts sessions last active in this window, each session in full'
export const COVERAGE = (names) => `excludes ${names}: their sessions are not in the library yet`
export const USAGE_COVERAGE = (read, total, why) => `usage read from ${read} / ${total} sessions${why ? ` (stopped: ${why})` : ''}`
export const SESSIONS_N = (n) => `${n} session${n === 1 ? '' : 's'}`
export const CALLS_N = (n) => `${n} model call${n === 1 ? '' : 's'}`
export const FROM = 'from'
export const HIT_LABEL = 'main thread cache hit'
export const HIT_UNKNOWN_TIP = "this provider's cache figures have an uncertain meaning"
export const EST_TIP = 'local estimated cost (usage × unit price), not a bill'
export const UNPRICED = (n) => `${n} model${n === 1 ? ' has' : 's have'} no unit price`
export const EMPTY_WINDOW = 'no sessions in this window'
export const PRICE_FAIL = (why) => `the price table could not be read: ${why}`
export const TBL = Object.freeze({ agent: 'agent', sessions: 'sessions', calls: 'model calls', cost: '≈ cost', hit: 'main thread cache hit', last: 'last active' })

// ── 最近的会话 · 盘上占用 · 开始使用 ───────────────────────────────────────────────────────────────────────────────────
export const ALL_SESSIONS = 'All sessions ›'
export const UNNAMED = (t) => `untitled session · last active ${t}`
export const PROBE_ONLY = 'token counts only'
export const PROBE_ONLY_TIP = 'this session has only token-count calls, no full content'
export const TITLE_FROM_AGENT = "title from the agent's own record"
export const READ_FAIL = (what, why) => `${what} could not be read: ${why}`
export const RETRY = 'Retry'
export const DISK_USE = (b) => `${b} used by asight`
export const SEE_STORAGE = 'Storage ›'
export const START_ROWS = Object.freeze([
  ['What it records', "Every call an agent sends to a model is recorded in full, with the model's response and usage, along with the agent's other network requests."],
  ['Where it is kept', 'These records are kept on this computer only.'],
  ['What it never does', 'It does not change your system proxy or take over the whole computer\'s network; it changes only the files listed for each agent, and turning capture off removes those changes.'],
  ['What happens next', "Switch an agent on: the next time it calls a model, the first record appears here by itself. asight never sends a request for you."],
])
export { MARK_TIP }
