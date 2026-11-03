// labels/library.mjs — the session library's fixed words (1.8). Closed sets keyed by trocar's own ids only
// (entrypoint cli/desktop, window 24h/7d/all, sort calls): a harness-defined code never keys a word here — agent
// names and icons come from core/chips.mjs (invariant 3). Nothing in this file is data.

import { WINDOW_LABEL, UNTITLED } from './common.mjs'

// ── the page head's scope control: the same words as the overview's ─────────────────────────────────────────────────
export const WINDOWS = WINDOW_LABEL

// ── the tool row ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const SEARCH_PLAIN = 'Search titles, projects or session ids'
// the tool row's menus, in sentence case like every head and menu on the board (1.5 §审美维度 9)
export const AGENT_MENU = 'Agent'
export const PROJECT_MENU = 'Project'
export const ALL_PROJECTS = 'All projects'
export const noSuchProject = (slug) => `${slug} (no such project)`
export const SORT_MENU = 'Sort'
export const SORTS = Object.freeze({ recent: 'Recent', calls: 'Model calls' })
export const CLEAR_FILTERS = 'Clear filters'
export const activeAgentChip = (name) => `${AGENT_MENU}: ${name}`
export const activeProjectChip = (name) => `${PROJECT_MENU}: ${name}`

// ── the caption row: only what changes how far the list can be trusted (D38); bookkeeping goes to 技术细节 ───────────
export const capNotAllRead = (n) => `${n} capture ${n === 1 ? 'file was' : 'files were'} not read in full; the list may be incomplete`
export const CAP_NOT_ALL_TIP = 'See Storage for each file'
export const SESSION_LIST = 'The session list' // what a failed read could not read (1.5 K-29: + the cause class, never the reason)
export const RETRY = 'Retry'
export const capOldList = (t) => `Below is the list as read at ${t}`
// the list on screen is the last stored answer while trocar makes a fresh one; `ago` is relTime's words
export const capStored = (ago) => `Updated ${ago} · refreshing`

// ── the table header ─────────────────────────────────────────────────────────────────────────────────────────────────
export const COL_AGENT = AGENT_MENU
export const COL_SESSION = 'Session'
export const COL_SESSION_TIP = 'The title comes from the agent\'s own records or from the captured requests; hover a title to see which. Without one, the session is untitled'
export const COL_CALLS = 'Model calls'
export const COL_LAST = 'Last active'

// ── day heads (only in the 最近 order; local dates): the two named days and the no-time group; other days are dates ─────
export const GROUPS = Object.freeze({ today: 'Today', yesterday: 'Yesterday', none: 'No time' })

// ── the title rule's three steps and their hover words (the session id rides along) ─────────────────────────────────
export { UNTITLED }
export const titleFromAgent = (id) => `The title comes from the agent\'s own records, not from captured content · session ${id}`
export const titleFromWire = (id) => `The title is taken from the captured requests · session ${id}`
export const titleNoKey = (id) => `The agent gave no title · session ${id}`

// ── the second line's marks (only when true / > 0; their hover words) ────────────────────────────────────────────────
export const ENTRY = Object.freeze({ cli: 'CLI', desktop: 'desktop' })
export const ENTRY_TIP = Object.freeze({ cli: 'Started from the command line', desktop: 'Started from the desktop app' })
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
// no list yet and none stored: the worker is building it from the index (first run, or the index was rebuilt)
export const LOADING = 'Reading the session list from the capture index. This usually takes a few seconds; on a large capture it can take a few minutes while the index is rebuilt.'
export const NO_SESSIONS = 'No sessions yet'
export const CAPTURING_HINT = 'Capture is on. Run an agent once and its session shows up here'
export const AS_OF = 'as of'
export const GO_CAPTURE = 'Go to capture'
export const FILTERED_EMPTY = 'No sessions match the filters'
export const agentNotCaptured = (name) => `${name} is not capturing`
export const CAPTURE_HEALTH = 'Capture health' // the 空态's second line when the health read failed (K-29)
