// labels/library.mjs — the session library's fixed words (1.8). Closed sets keyed by asight's own ids only
// (entrypoint cli/desktop, window 24h/7d/all, sort calls): a harness-defined code never keys a word here — agent
// names and icons come from core/chips.mjs (invariant 3). Nothing in this file is data.
import { clip } from '../core/fmt.mjs'

// ── the page head's scope control ────────────────────────────────────────────────────────────────────────────────────
export const WINDOWS = Object.freeze({ '24h': '24 小时', '7d': '7 天', all: '全部' })

// ── the tool row ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const SEARCH_PLAIN = '搜索标题、项目或会话 id'
export const SEARCH_WITH_PROMPT = '搜索标题、首条提问、项目或会话 id'
// the tool row's menu key is lowercase like every other UI copy word (未识别的 agent, 多个 agent); the RFC sketch spells
// it with a capital first letter, but the invariant-3 gate holds that capitalised word as a quoted tool-name literal —
// lowercase here, flagged in review as an open question
export const AGENT_MENU = 'agent'
export const PROJECT_MENU = '项目'
export const ALL_PROJECTS = '全部项目'
export const noSuchProject = (slug) => `${slug}(没有这个项目)`
export const SORT_MENU = '排序'
export const SORTS = Object.freeze({ recent: '最近', calls: '模型调用' })
export const CLEAR_FILTERS = '清除筛选'
export const activeAgentChip = (name) => `agent:${name}`
export const activeProjectChip = (name) => `项目:${name}`

// ── the caption row: only what changes how far the list can be trusted (D38); bookkeeping goes to 技术细节 ───────────
export const capNotAllRead = (n) => `◐ 有 ${n} 个采集文件没读全,列表可能不全`
export const CAP_NOT_ALL_TIP = '去 存储 看每个文件的情况'
export const capCorrupt = (k) => `${k} 行解析不了`
export const capNoId = (u) => `${u} 条记录没有 id,列出来了,但块打不开`
export const capReadFail = (code) => `读不出会话列表:服务返回 ${code}`
export const CAP_CONN_FAIL = '连不上 asight 服务'
export const RETRY = '重试'
export const capOldList = (t) => `下面是 ${t} 读到的列表`
// 技术细节's rows: the read bookkeeping (未计数 · 半行 · 重读 · 其余没读) and, per unreadable file, its own line
export const TECH_UNCOUNTED = '坏行未计数(分片模式)'
export const techTail = (names) => `半行:${names.join('、')}(写入中,或写者停在半行)`
export const techResets = (names) => `变小过、已重读:${names.join('、')}`
export const techSkipped = (names) => `其余没读:${names.join('、')}(不是 .ndjson 的文件、子目录)`

// ── the table header ─────────────────────────────────────────────────────────────────────────────────────────────────
export const COL_SESSION = '会话'
export const COL_SESSION_TIP = '标题来自 agent 自己的记录,不是采集到的内容;没有时取第一条提问'
export const COL_CALLS = '模型调用'
export const COL_LAST = '最后活动'

// ── group names (only in the 最近 order; local dates) ────────────────────────────────────────────────────────────────
export const GROUPS = Object.freeze({ today: '今天', yesterday: '昨天', earlier: '更早', none: '没有时间' })

// ── the title rule's three steps and their hover words (the session id rides along) ─────────────────────────────────
export const UNTITLED = '未命名会话'
export const TITLE_MAX = 80
export const titleFromAgent = (id) => `标题来自 agent 自己的记录,不是采集到的内容 · 会话 ${id}`
export const titleFromPrompt = (id) => `取自第一条提问(最多 ${TITLE_MAX} 字) · 会话 ${id}`
export const TITLE_GUESS_MORE = '哪一条是人写的提问,是按规则猜的'
export const titleNoPrompt = (id) => `agent 没有给标题,记录里也认不出第一条提问 · 会话 ${id}`
export const titleNoKey = (id) => `agent 没有给标题 · 会话 ${id}`
// the displayed title of a first prompt: wrapped in 「」, at most TITLE_MAX chars
export const promptTitle = (t) => `「${clip(String(t), TITLE_MAX)}」`

// ── the second line's marks (only when true / > 0; their hover words) ────────────────────────────────────────────────
export const ENTRY = Object.freeze({ cli: '命令行', desktop: '桌面版' })
export const INFERRED_TIP = '这个 agent 是从请求头推断的,不是采集器按进程认出来的'
export const SYNTHESIZED = '会话边界是推测的'
export const SYNTHESIZED_TIP = '请求里没有会话键,按系统提示和时间把请求归成一个会话,可能并错或分错'
export const MULTI = '多个 agent'
export const multiTip = (names) => `这个会话 id 下有几个 agent 的请求:${names.join('、')}`
export const SUBAGENT = '含子 agent'
export const SUBAGENT_TIP = '这个会话启动过子 agent。只在 agent 的记录里认得出子 agent 时才标;没有这个标,不等于没有子 agent'
export const markLogged = (n) => `只记日志 ${n}`
export const loggedTip = (n) => `另有 ${n} 次模型调用按保存设置只记了日志:不在回放里,也不算进模型调用数`
export const PROBE_ONLY = '只有 token 计数'
export const PROBE_ONLY_TIP = '这个会话只有 token 计数请求(不生成回复、不计费),没有模型调用'

// ── the states that stand in for the table (words here; the matrix's order is 1.5's) ────────────────────────────────
export const LOADING = '正在载入…'
export const NO_SESSIONS = '还没有会话'
export const CAPTURING_HINT = '采集在进行,运行一次 agent 就会出现在这里'
export const AS_OF = '截至'
export const GO_CAPTURE = '去采集'
export const FILTERED_EMPTY = '没有符合筛选的会话'
export const agentNotCaptured = (name) => `${name} 现在没在被采集`
export const readCapFail = (why) => `读不到采集状态:${why}`
