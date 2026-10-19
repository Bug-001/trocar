// labels/library.mjs — the session library's fixed words (1.8). Closed sets keyed by asight's own ids only
// (entrypoint cli/desktop, window 24h/7d/all, sort calls): a harness-defined code never keys a word here — agent
// names and icons come from core/chips.mjs (invariant 3). Nothing in this file is data.
import { clip } from '../core/fmt.mjs'

// ── the page head's scope control ────────────────────────────────────────────────────────────────────────────────────
export const WINDOWS = Object.freeze({ '24h': '24 h', '7d': '7 days', all: 'All' })

// ── the tool row ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const SEARCH_PLAIN = 'Search titles, projects or session ids'
export const SEARCH_WITH_PROMPT = 'Search titles, first prompts, projects or session ids'
// the tool row's menu key is lowercase like every other UI copy word (unknown agent, several agents); the RFC sketch spells
// it with a capital first letter, but the invariant-3 gate holds that capitalised word as a quoted tool-name literal —
// lowercase here, flagged in review as an open question
export const AGENT_MENU = 'agent'
export const PROJECT_MENU = 'project'
export const ALL_PROJECTS = 'All projects'
export const noSuchProject = (slug) => `${slug} (no such project)`
export const SORT_MENU = 'sort'
export const SORTS = Object.freeze({ recent: 'Recent', calls: 'Model calls' })
export const CLEAR_FILTERS = 'Clear filters'
export const activeAgentChip = (name) => `agent: ${name}`
export const activeProjectChip = (name) => `project: ${name}`

// ── the caption row: only what changes how far the list can be trusted (D38); bookkeeping goes to 技术细节 ───────────
export const capNotAllRead = (n) => `◐ ${n} capture files were not read in full; the list may be incomplete`
export const CAP_NOT_ALL_TIP = 'See Storage for each file'
export const capCorrupt = (k) => `${k} lines could not be parsed`
export const capNoId = (u) => `${u} records have no id: they are listed, but their blocks cannot be opened`
export const capReadFail = (code) => `Could not read the session list: the capture service returned ${code}`
export const CAP_CONN_FAIL = 'Cannot reach the asight capture service'
export const RETRY = 'Retry'
export const capOldList = (t) => `Below is the list as read at ${t}`
// 技术细节's rows: the read bookkeeping (未计数 · 半行 · 重读 · 其余没读) and, per unreadable file, its own line
export const TECH_UNCOUNTED = 'Bad lines not counted (segment index)'
export const techTail = (names) => `Partial last line: ${names.join(', ')} (still being written, or the writer stopped mid-line)`
export const techResets = (names) => `Shrank and were read again: ${names.join(', ')}`
export const techSkipped = (names) => `Not read: ${names.join(', ')} (not .ndjson files, or subfolders)`

// ── the table header ─────────────────────────────────────────────────────────────────────────────────────────────────
export const COL_SESSION = 'Session'
export const COL_SESSION_TIP = 'The title comes from the agent\'s own records, not from captured content. Without one, the first prompt is used'
export const COL_CALLS = 'Model calls'
export const COL_LAST = 'Last active'

// ── group names (only in the 最近 order; local dates) ────────────────────────────────────────────────────────────────
export const GROUPS = Object.freeze({ today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier', none: 'No time' })

// ── the title rule's three steps and their hover words (the session id rides along) ─────────────────────────────────
export const UNTITLED = 'Untitled session'
export const TITLE_MAX = 80
export const titleFromAgent = (id) => `The title comes from the agent\'s own records, not from captured content · session ${id}`
export const titleFromPrompt = (id) => `Taken from the first prompt (at most ${TITLE_MAX} characters) · session ${id}`
export const TITLE_GUESS_MORE = 'Which message is the human\'s prompt is inferred by a rule'
export const titleNoPrompt = (id) => `The agent gave no title, and no first prompt was found in its records · session ${id}`
export const titleNoKey = (id) => `The agent gave no title · session ${id}`
// the displayed title of a first prompt: wrapped in 「」, at most TITLE_MAX chars
export const promptTitle = (t) => `“${clip(String(t), TITLE_MAX)}”`

// ── the second line's marks (only when true / > 0; their hover words) ────────────────────────────────────────────────
export const ENTRY = Object.freeze({ cli: 'CLI', desktop: 'desktop' })
export const INFERRED_TIP = 'This agent was inferred from the request headers, not identified by its process'
export const SYNTHESIZED = 'session boundary inferred'
export const SYNTHESIZED_TIP = 'The requests carry no session key, so they were grouped into one session by system prompt and time. They may be merged or split wrongly'
export const MULTI = 'several agents'
export const multiTip = (names) => `Requests from several agents share this session id: ${names.join(', ')}`
export const SUBAGENT = 'has sub-agents'
export const SUBAGENT_TIP = 'This session started sub-agents. The mark shows only when the agent\'s records name them, so no mark does not mean no sub-agents'
export const markLogged = (n) => `log only ${n}`
export const loggedTip = (n) => `${n} more model calls were kept as log only by the retention settings: they are not in the replay and not in the model call count`
export const PROBE_ONLY = 'token counts only'
export const PROBE_ONLY_TIP = 'This session has only token count requests (no reply, no charge) and no model calls'

// ── the states that stand in for the table (words here; the matrix's order is 1.5's) ────────────────────────────────
export const LOADING = 'Loading…'
export const NO_SESSIONS = 'No sessions yet'
export const CAPTURING_HINT = 'Capture is on. Run an agent once and its session shows up here'
export const AS_OF = 'as of'
export const GO_CAPTURE = 'Go to capture'
export const FILTERED_EMPTY = 'No sessions match the filters'
export const agentNotCaptured = (name) => `${name} is not capturing`
export const readCapFail = (why) => `Could not read capture health: ${why}`
