// labels/overview.mjs — the words of the 总览 page (1.7): the cards' names, the capture card's fixed parts, every
// 事项 sentence, the stats figures, the disk and first-run cards. Fixed text only — keyed by asight's own closed sets
// (windows, condition kinds, source names), never by a harness-defined code (those carry their own words from the
// server, 1.5 §数据规则). The capture card's state sentence itself is NOT here: it is core/capture-verdict.mjs's, so
// the capture card and the 采集 page cannot say two things (1.7 §采集卡).
import { MARK_TIP } from './common.mjs'

export const CARD = Object.freeze({ capture: '采集', items: '要处理的事', stats: '统计', recent: '最近的会话', disk: '磁盘', start: '开始使用' })

// the stats window of the page head (1.7 §统计窗): three fixed choices, the route's `window` param
export const WINDOWS = Object.freeze(['24h', '7d', 'all'])
export const WINDOW_LABEL = Object.freeze({ '24h': '24 小时', '7d': '7 天', all: '全部' })

export const GO_CAPTURE = '去采集 ›'
export const READ_FILES_FAIL = (n) => `有 ${n} 个记录文件读不出`
export const AGENTS_ON = (on, total) => `${on} / ${total} 个 agent 开着`

// ── 要处理的事 ─────────────────────────────────────────────────────────────────────────────────────────────────────
// the caption row of the items card. The window the failure groups cover is the health read's own (read.window_hours).
export const FAIL_LIST = '失败列表'
export const FAIL_WINDOW = (h) => `只列最近 ${h} 小时`
export const NO_ITEMS = '没有要处理的事'
// which sources this round could not read (1.7 事项目录 · 不全说明): 「采集状态、价表没读到,下面可能不全」
export const SRC_NAME = Object.freeze({ health: '采集状态', projects: '会话列表', retention: '保存设置', pricing: '价表', usage: '统计', traffic: '流量' })
export const PARTIAL_NOTE = (names) => `${names.join('、')}没读到,下面可能不全`
export const CAP_STALE_AS_OF = (t) => `采集状态截至 ${t}`
export const MORE_OF = (n) => `另有 ${n} 条 ›`

// O1 / O1′ — a condition that still holds. The sentence prefers the daemon's own `reason` (it says what to do about
// it); the kind words below are the fallback for a condition that carries none. These kinds are asight's own closed
// set (src/health/flows.mjs foldFlows), so they may be keyed here; the 采集 page (1.9) words the same kinds for its own
// rows and should adopt these words when it lands (labels-complete reconciles the two).
export const KIND_WORD = Object.freeze({
  untrusted: '不在采集的信任名单里',
  'negative-cache': '在失败缓存里,先不采',
  degraded: '特权助手不在,采集降级',
  'helper-version': '特权助手版本不配',
  'state-mismatch': '期望的开 / 关与实际不一致',
  'ca-invalid': '采集 CA 不可用',
  retention: '保存设置读不出',
})
// [待 #45] the one code whose meaning is 「asight 挡住了它的网络」(1.6 §9.6): its item says so
export const NET_BLOCKED_CODE = 'forwarder-down'
export const NET_BLOCKED = (why) => `现在可能连不上网:${why}`
export const NOT_CAPTURED = '现在没有在采集'
export const AGENT_ITEM = (name, why) => `${name}:${why}`
export const ETC_K = (k) => ` 等 ${k} 处`
export const AS_OF_TAIL = (t) => `(截至 ${t})`
export const SVC_ITEM = (why) => `采集服务:${why}`

// O3 — a failure group of the last 24 h. The sentence itself is the group's own reason (the server's words); the key
// rides in 技术细节 until labels/capture.mjs (1.9) words the closed set of codes.
export const FAILURES = '采集失败'
export const RAW_FAILURES = '封存或读取出错'
export const FAIL_TIMES = (n) => `${n} 次`
export const SVC_SUBJECT = '采集服务'

// O4 / O5 — the last install's notes, what an uninstall could not undo
export const INSTALL_NOTES = (n) => `上次安装有 ${n} 条说明要看`
export const INSTALL_FAILED = '上次安装没成功'
export const UNINSTALL_NOTES = (n) => `上次卸载有 ${n} 条说明要看`
export const UNINSTALL_FAILED = '上次卸载没成功'
export const MANIFEST_ERROR = '安装清单读不出'
export const RESIDUE_UNFINISHED = (n) => `安装没做完,留下 ${n} 项`
export const RESIDUE_LEFT = (n) => `卸载后还留着 ${n} 项`

// O6 — files that could not be read whole
export const FILES_NOT_READ = (n) => `有 ${n} 个采集文件没读全`

// O8 / O9 — models without a price; a host seen for the first time
export const UNPRICED = (n) => `${n} 个模型没有单价`
export const NO_MODEL_NAME = '没有模型名'
export const NEW_HOST = (name, host) => `${name} 第一次连 ${host}`
export const BY_STATS = '按已整理进统计的记录,推测'

// ── 统计 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const AS_OF = (t) => `截至 ${t}`
export const SCOPE_LINE = '算最后活动在这段时间里的会话,整段会话都计入'
export const COVERAGE = (names) => `不含 ${names}:它们的会话还不在库里`
export const SESSIONS_N = (n) => `会话 ${n}`
export const CALLS_N = (n) => `模型调用 ${n}`
export const COST_APPROX = '$'
export const FROM = '起'
export const CANT = '算不出'
export const HIT_PCT = (p) => `主对话缓存命中 ${p}%`
export const HIT_LABEL = '主对话缓存命中'
export const HIT_UNKNOWN_TIP = '这个服务商的缓存数字含义不确定'
export const BREAKS_N = (n) => `缓存断开 ${n} 处`
export const EXTRA_LABEL = '≈ 多花'
export const WASTED_CANT_K = (k) => `${k} 处算不出`
export const WASTED_WHY = Object.freeze({
  'no-ref': '没有可对比的前一次调用', 'no-usage': '这一行没有用量', 'no-write-counter': '参考调用没有报缓存写入数', 'no-price': '没有这一行模型的单价',
})
export const MOST_EXPENSIVE = '最贵的会话 ›'
export const EST_TIP = '本地估价(用量 × 单价),不是账单'
export const EMPTY_WINDOW = '这段时间里没有会话'
export const PRICE_FAIL = (why) => `价表读不出:${why}`
export const TBL = Object.freeze({ agent: 'agent', sessions: '会话', calls: '模型调用', cost: '≈ 花费', hit: '主对话缓存命中', breaks: '缓存断开', last: '最近活动' })

// ── 最近的会话 · 磁盘 · 开始使用 ───────────────────────────────────────────────────────────────────────────────────
export const ALL_SESSIONS = '全部会话 ›'
export const UNNAMED = (t) => `未命名会话 · 最后活动 ${t}`
export const PROBE_ONLY = '只有 token 计数'
export const PROBE_ONLY_TIP = '这一会话只有带 token 计数的调用,没有完整内容'
export const FROM_FIRST_PROMPT = '取自第一条提问'
export const TITLE_FROM_AGENT = '标题来自 agent 自己的记录'
export const READ_FAIL = (what, why) => `读不到${what}:${why}`
export const RETRY = '重试'
export const DISK_USE = (b) => `asight 占用 ${b}`
export const DISK_AT_LEAST = (b) => `asight 占用 至少 ${b}`
export const DISK_PER_DAY = (b) => `每天约增加 ≈ ${b}`
export const DISK_STALE = '库里最新的调用早于 24 小时前'
export const SEE_STORAGE = '看存储 ›'
export const START_ROWS = Object.freeze([
  ['记录什么', 'asight 记录 agent 每次发给模型的完整内容、模型的回复与用量,以及 agent 的其他网络请求。'],
  ['存在哪', '这些记录只存在这台电脑上。'],
  ['之后会怎样', '装好以后,agent 下一次调用模型,这里会自己出现第一条记录。asight 不会替你发任何请求。'],
])
export { MARK_TIP }
