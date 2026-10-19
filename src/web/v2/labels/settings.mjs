// labels/settings.mjs — the 设置 screens' fixed words (1.11): card names, the disk-use words, the price page and the
// appearance page. One word per meaning (1.5 §词表); nothing here is keyed by a harness id, a host or an endpoint
// (invariant 3 — those arrive with the data).

// 卡名 (the page head carries only the screen's name; these are the cards under it)
export const CARD_DISK = '磁盘', CARD_PRICE = '单价', CARD_UNPRICED = '没有单价的模型', CARD_THEME = '明暗'

// 磁盘卡
export const DISK_TOTAL = 'asight 占用', DISK_TOTAL_FLOOR = '至少', // unreadable paths make the total a floor
  DISK_PER_DAY = '每天约增加', DISK_PER_DAY_AS_OF = '截至', STORE_TOO_OLD = '库里最新的调用早于 24 小时前',
  CAPTURE_PAGE_LINE = '各 agent 的开关、点名项和本机网络环境在采集页', CAPTURE_PAGE_HREF = '#/capture',
  BAD_FILES = (n) => `有 ${n} 个采集文件读的时候出了问题`, BAD_FILES_SHOW = '看是哪些', POP_FLOOR = '起'

// 磁盘上的文件(技术细节的段名)与磁盘用途词(键 = src/query/disk.mjs : DISK_GROUPS,顺序同)
export const DISK_GROUP_NAME = Object.freeze({ captures: '采集文件', sealed: '封存文件', sessions: '会话副本', logs: '日志', other: '其他' })
export const FILES_DIR = '目录', FILES_SEAL_RATIO = '压缩保存比',
  FILES_SEAL_NONE = '没有可读的封存文件', FILES_UNREADABLE = '读不了的', FILES_UNREADABLE_NOTE = '这些路径没算进总数,总数是下限',
  FILES_CAPTURE_TROUBLE = '采集文件读的问题'

export const RETRY = '重试'

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
