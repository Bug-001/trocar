// labels/traffic.mjs — the fixed words of 流量 / the host page / the request detail (1.10, 2.6 §C). Closed sets keyed by
// asight's own ids only (the seven traffic classes, the three retention levels, the body kinds);
// a harness-defined code never reaches a key here — its words come from the server's answer (1.5 §数据规则).
import { CLASS_NAME } from '../core/classes.mjs'

// ── the traffic table ───────────────────────────────────────────────────────────────────────────────────────────────────
export const WINDOW_LABEL = Object.freeze([{ value: '1h', label: '1 小时' }, { value: '24h', label: '24 小时' }, { value: '7d', label: '7 天' }, { value: 'all', label: '全部' }])
export const DEFAULT_WINDOW = '24h'
export const AS_OF = '截至'
export const COVERS_PREFIX = '只含已整理进统计的 agent:' // followed by each agent's name
export const AGENT_SOURCE_NOTE = 'agent 按进程认;旧采集的记录没有进程信息,agent 是按请求头推测的,这张表分不出是哪几行'
export const AGENT_AGENT_TIP = '旧采集的记录没有进程信息,agent 是按请求头推测的'
export const FILTER_AGENT = 'agent'
export const FILTER_CLASS = '类别'
export const CLASS_FILTER_NOTE = (word) => `只列出有${word}请求的 host;数字是这个 host 全部类别的合计`
export const WHAT_IS_KEPT = '这一类保存什么 ›'
export const COL = Object.freeze({ agent: 'agent', host: 'host', first: '首次出现', requests: '请求', sent: '发出', recv: '收回', classes: '主要类别', total: '合计' })
export const BYTES_TIP = '请求体 / 响应体的线上字节,不含头'
export const NO_HOST = '没记下 host'
export const NEW = '新'
export const NEW_TIP = '这个 agent 在这 24 小时之前从没连过这个 host(按已整理进统计的记录)'
export const FIRST_SEEN_TIP = '按已整理进统计的记录'
export const UNCLASSIFIED_TIP = '这个 agent 的流量还不能细分'
export const UNRECORDED = '未记录'
export const UNRECORDED_N = (n) => `${n} 条未记录`
export const LOADING = '正在读取'
export const EMPTY_WINDOW = '这段时间没有流量'
export const EMPTY_WINDOW_CLASS = (word) => `这段时间没有${word}的流量`
// the two store states (a closed set of the server's own reason codes); the command comes from the server's answer
export const RETRY = '重试'
export const READ_FAILED = (why) => `没读到流量:${why}`

// ── the host page ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const TOTAL_N = (n) => `共 ${n} 条`
export const EMPTY_HOST = '这段时间没有发往这个 host 的请求'
export const EMPTY_HOST_CLASS = (word) => `这段时间没有发往这个 host 的${word}请求`
export const PICK_ONE = '选一条请求,看它的请求与响应'
export const CLOSE_DETAIL = '关闭请求详情'
export const OPEN_IN_REPLAY = '在回放中打开 ›'
export const MODEL_CALL_LEAD = '这是一次模型调用,内容在回放里 ›'
export const RAW_REQUEST = '原始请求'
export const FAILED = '失败'
export const UNKNOWN_DAY = '—'

// the retention mark of a row (a closed set: full · log · legacy-meta). The › of 只记日志 links to the storage cell.
export const RETENTION_MARK = Object.freeze({
  log: { label: '只记日志', linked: true },
  'legacy-meta': { label: '只存了长度', tip: '较早采集的记录,只存了长度' },
  full: null,
})

// ── the request detail (2.6 §C) ────────────────────────────────────────────────────────────────────────────────────────
export const REQ_HEADERS = '请求头'
export const RESP_HEADERS = '响应头'
export const REQ_BODY = '请求体'
export const RESP_BODY = '响应'
export const WIRE_SIZE = '线上大小'
export const WIRE_N = (n) => `线上 ${n} 字节`
export const CONNECTED_HOST = '连接的域名'
export const REQUESTED_HOST = '请求里写的域名'
export const HOST_DIFFERS = '连接的域名和请求里的域名不一致'
export const MASKED = '已遮挡'
export const REVEAL = '显示'
export const MASK_NOTE = '显示时已遮挡,存的是原文'
export const MASK_NOTE_OLD = '采集时已遮挡(旧记录)'
export const MASKED_COPY = '(已遮挡)'
export const OLD_REDACTED = '<redacted>'
export const CLIPPED = (shown, total) => `已截断显示 · 前 ${shown} / 共 ${total} 字符`
export const REST_IN_SOURCE = '其余在源记录里'
export const VERBATIM_BYTES = (n) => `逐字 · ${n} 字节`
export const PARSED_JSON = '解析后的 JSON(按对象重新排版)'
export const PARSED_JSON_CHARS = (n) => `解析后的 JSON · ${n} 字符`
export const BINARY_LABEL = (n) => `二进制 · ${n} 字节 · 逐字存为 base64`
export const UNDECODED = '压缩请求体未解码'
export const EMPTY_BODY = '没有体'
export const NO_BODY = '这条记录里没有体'
export const UNKNOWN_KIND = '原因未知'
export const DECODED_FROM = (enc) => `请求体在线上是压缩的(${enc}),这里是解压后的文本`
export const PREFIX_ONLY = (n, total) => `只存了前 ${n} / 共 ${total} 字节`
export const FOLD_PREFIX = '前缀,不是完整的体'
export const REQ_LEGACY = '请求:较早采集的记录,只存了长度'
export const RESP_LEGACY = '响应:较早采集的记录,只存了长度'
export const REQ_TRUNCATED = '请求:已截断,只存了一个前缀'
export const RESP_TRUNCATED = '响应:已截断,只存了一个前缀'
export const REQ_PARTIAL = '请求:不完整,没传完'
export const RESP_PARTIAL = '响应:不完整,没传完'
export const RESP_RESERIALIZED = '响应是解析后重新序列化的 JSON,不是逐字字节'
export const RESP_UNDECODED = (enc) => `响应:未能解码(${enc}),字节还在源记录里`
export const ASIGHT_ADDED = 'asight 加的'
export const DETAIL_READ_FAILED = (why) => `没读到这条请求:${why}`
export const classWord = (id) => (Object.prototype.hasOwnProperty.call(CLASS_NAME, id) ? CLASS_NAME[id] : String(id))
