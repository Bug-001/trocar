// labels/settings.mjs — the 设置 screens' fixed words (1.11): card names, the D40⑥ level words, the 表注行, the
// confirm box, the receipts, the change-source words and the disk-use words. One word per meaning (1.5 §词表);
// nothing here is keyed by a harness id, a host or an endpoint (invariant 3 — those arrive with the data).
// The ETL words are 1.5 K-24's closed set, exported for the overview page's own cards (its O6/O7/O8 share the
// 取值函数 and the wording with this screen).

// 保存级别 (D40⑥, N-13): the two levels and what each one really keeps — the words never say 「存内容」, which
// would read as a privacy switch (`log` still keeps the headers and the metadata).
export const LEVEL = Object.freeze({ full: '全部', log: '只记日志' })
export const levelOf = (v) => LEVEL[v] || String(v) // a level this file does not know rides verbatim (invariant 4)
export const LEVEL_TIP = Object.freeze({
  full: '请求和回复的内容逐字保存(每个方向最多 64 MiB)',
  log: '只存头与元数据,不存内容;只记内容的字节数',
})

// 卡名 (the page head carries only the screen's name; these are the cards under it)
export const CARD_DISK = '磁盘', CARD_KEEP = '保存什么', CARD_PRICE = '单价', CARD_UNPRICED = '没有单价的模型', CARD_THEME = '明暗'

// 磁盘卡
export const DISK_TOTAL = 'asight 占用', DISK_TOTAL_FLOOR = '至少', // unreadable paths make the total a floor
  DISK_PER_DAY = '每天约增加', DISK_PER_DAY_AS_OF = '截至', STORE_TOO_OLD = '库里最新的调用早于 24 小时前',
  CAPTURE_PAGE_LINE = '各 agent 的开关、点名项和本机网络环境在采集页', CAPTURE_PAGE_HREF = '#/capture',
  BAD_FILES = (n) => `有 ${n} 个采集文件读的时候出了问题`, BAD_FILES_SHOW = '看是哪些', DISK_FILES = '磁盘上的文件'

// 磁盘上的文件(技术细节的段名)与磁盘用途词(键 = src/query/disk.mjs : DISK_GROUPS,顺序同)
export const DISK_GROUP_NAME = Object.freeze({ captures: '采集文件', sealed: '封存文件', sessions: '会话副本', duckdb: '分析库', logs: '日志', other: '其他' })
export const FILES_DIR = '目录', FILES_BY_USE = '按用途', FILES_SEAL_RATIO = '压缩保存比',
  FILES_SEAL_NONE = '没有可读的封存文件', FILES_UNREADABLE = '读不了的', FILES_UNREADABLE_NOTE = '这些路径没算进总数,总数是下限',
  FILES_DB = '分析库', FILES_CAPTURE_TROUBLE = '采集文件读的问题'

// 保存什么卡的表头与行
export const COL_AGENT = 'agent', COL_TOTAL = '合计',
  LEGACY_ROW = '较早采集的记录 · 只存了长度',
  LEGACY_TIP = '2026-10-07 之前采的非模型调用只存了请求体的长度,响应体的大小没有记',
  UNMATCHED = '不起作用',
  UNMATCHED_TIP = '还认不出这个 agent 的这类流量,这里的设置不起作用',
  UNMATCHED_SET = (level) => `设置里写的是 ${level}`,
  REC_UNRECORDED = '未记录', // a pre-D40 response size was never recorded (never a 0)
  CHANGING = '正在改…'

// 表注行,按出现的条件(1.11 §表注行;都在卡里,不在页头)
export const NOTE_ALWAYS = '改动只影响之后开始的调用;已存的数据不删',
  AS_OF_LINE = (t) => `按类的数字截至 ${t}`,
  STORE_EMPTY = '库里还没有调用',
  STORE_TOO_OLD_WINDOW = '库里最新的调用早于这个时间窗:可能没有调用,也可能库还没更新',
  NOTE_LEGACY = '合计不含较早采集的记录',
  ETL_NEED = '需要先运行一次 asight etl', // K-24
  ETL_REBUILD = '需要重建', // K-24
  SIZES_UNREADABLE = '按类的数字读不到',
  READ_ONLY = '看板以只读方式启动,这里只显示级别',
  SETTINGS_BAD_WHOLE = '保存设置读不出:修好之前,每次调用都按「全部」保存',
  SETTINGS_BAD_CELLS = (n) => `保存设置里有 ${n} 处写错了:这几处按「全部」保存`,
  SETTINGS_MISSING_TECH = '还没有设置文件:每一格都按「全部」保存',
  SETTINGS_FIX_TECH = '修好或删掉这个文件后刷新'

// 改级别(N-12:只有 llm / token-count 改成只记日志先确认;焦点在 取消)
export const CONFIRM_Q = '改成只记日志?',
  CONFIRM_LLM = (agent) => `之后 ${agent} 的模型调用只记日志:不存请求和回复的内容,这些调用不进回放。已经存下的不受影响。`,
  CONFIRM_TC = (agent) => `之后 ${agent} 的 token 计数只记日志:不存请求和回复的内容,回放里只剩次数,看不到数出的 token 数。已经存下的不受影响。`,
  CONFIRM_YES = '改成只记日志'

// 回执(写在那一格里;技术细节放服务端原文)
export const RECEIPT_OK = (from, to) => `${levelOf(from)} → ${levelOf(to)} · 之后开始的调用生效`,
  RECEIPT_LOG_ERR = '修改记录没写成', RECEIPT_NOOP = (to) => `本来就是${levelOf(to)}`,
  RECEIPT_403 = '改动被拒绝', RECEIPT_400 = '没改成', RECEIPT_409 = '设置文件读不出,没改',
  RECEIPT_READONLY = '看板现在以只读方式运行,没改', RECEIPT_CONN = '连不上 asight 服务,没改', RETRY = '重试'

// 技术细节里的两条改法(控制面关着时)
export const TECH_CONTROL_ON = '启动时带控制面', TECH_KEEP_CMD = (h) => `asight keep ${h} <类别> <full|log>`,
  TECH_ETL_AFTER = '建好以后重启 asight serve 才会读到'

// 最近的修改
export const CHANGES = '最近的修改', CHANGES_NONE = '还没有修改', CHANGES_BAD = '修改记录读不全',
  CHANGE_SOURCE = Object.freeze({ board: '看板', cli: '命令行', file: '手改设置文件' }),
  sourceOf = (v) => CHANGE_SOURCE[v] || String(v)

// 弹出层
export const POP_CALLS = (n) => `${n} 次调用`, POP_WIRE = '线上', POP_REQ = '请求', POP_RESP = '响应',
  POP_STORED = (z) => `存下 ${z}(压缩保存前的大小)`,
  POP_SEALED = (w) => `压缩保存后 ≈ ${w}`,
  POP_SEALED_TIP = '用全部封存文件的总体比值乘出来,只有一个全局数,对任何一类都只是估计',
  POP_KEPT = (full, log) => `已经存下的:全部 ${full} 次 · 只记日志 ${log} 次`,
  POP_KEPT_TIP = '改动只影响之后开始的调用:这一格里两种都有,按各自存下的算',
  POP_SEE_TRAFFIC = '看这类流量', POP_FLOOR = '起', POP_UNRECORDED_N = (n) => `${n} 次没记大小`

// 价格页
export const PRICE_NOTE = '估价 = 用量 × 这里的单价,是本地估算,不是账单 · 美元 / 百万 token',
  PRICE_FROM = (p) => `来自 ${p}`, PRICE_DEFAULT = '用的是 asight 自带的默认单价',
  COL_KEY = '模型名包含', COL_IN = '输入', COL_OUT = '输出', COL_WRITE = '写缓存', COL_READ = '读缓存',
  PRICE_READ_FAIL = '读不到单价表', PRICE_BAD_SHAPE = '单价表的格式不对',
  UNPRICED_AS_OF = '截至', UNPRICED_SESSIONS = (n) => `用在 ${n} 个会话里`,
  UNPRICED_NONE = '用到的模型都有单价', UNPRICED_NO_MODEL = '没有模型名',
  COPY_TEMPLATE = '复制模板',
  TEMPLATE_HINT = '把四个 null 换成每百万 token 的美元单价,依次是输入、输出、写缓存、读缓存;刷新页面后生效',
  TECH_MATCH = '先找和模型名完全相同的一行;没有就取模型名里包含的最长的一个键;按模型名里的字匹配,不分服务商',
  TECH_WRITE_ONE = '写缓存只有一个单价,服务商按缓存时长分价时,估价按这一个价算',
  TECH_PRICING_PATH = '服务端读环境变量 ASIGHT_PRICING 指的文件,没设时读它的默认位置;改完文件,刷新页面后生效'

// 外观页
export const THEME_SYSTEM = '跟随系统', THEME_LIGHT = '亮', THEME_DARK = '暗',
  THEME_UNSTORABLE = '这个浏览器不让存这个选择,刷新后回到跟随系统'
