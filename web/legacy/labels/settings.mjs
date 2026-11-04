// labels/settings.mjs — the 设置 screens' fixed words (1.11): card names, the disk-use words, the price page and the
// appearance page. One word per meaning (1.5 §词表); nothing here is keyed by a harness id, a host or an endpoint
// (invariant 3 — those arrive with the data).

// 卡名 (the page head carries only the screen's name; these are the cards under it)
export const CARD_DISK = 'Disk', CARD_PRICE = 'Unit prices', CARD_UNPRICED = 'Models without a unit price', CARD_THEME = 'Theme'

// 磁盘卡
export const DISK_TOTAL = 'Used by trocar', DISK_PER_DAY = 'Estimated growth per day', AS_OF = 'as of',
  CAPTURE_PAGE_LINE = 'Each agent\'s switch and the local network environment are on the capture page', CAPTURE_PAGE_HREF = '#/capture',
  BAD_FILES = (n) => `${n} capture file problem${n === 1 ? '' : 's'} when read`, BAD_FILES_SHOW = 'Show which', THIS_PAGE = 'This page',
  FILES_CHECK = 'The capture file check'

// 磁盘上的文件(技术细节)
export const FILES_SEAL_RATIO = 'Sealed compression ratio', ESTIMATE = 'estimate', FILES_SEAL_NONE = 'No readable sealed files',
  FILES_READ_PROBLEMS = 'Read problems', FILES_READ_NOTES = 'Indexed while reading',
  SLOW_NOTE = 'This page was slower because some capture files were indexed while it read them'

// 保存什么卡(七行七个级别控件,D60③;改法也写在技术细节)
export const CARD_CLASSES = 'What is stored', CLASSES_AS_OF = 'Counts as of',
  WINDOWS = Object.freeze([{ value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }, { value: 'all', label: 'All' }]),
  COL_CLASS = 'Class', COL_KEEP = 'Level', COL_CALLS = 'Calls', COL_STORED = 'Stored', COL_RULES = 'Matches', COL_INFO = 'More', TOTAL = 'Total',
  KEEP_NAME = Object.freeze({ full: 'Everything', log: 'Log only' }), NO_CLASS = 'No class recorded',
  CLASSES_FILE = 'Settings file', LEVEL_OF = (name) => `Level of ${name}`, CHANGING = 'Changing…',
  POP_STORED = (b) => `Stored ${b} (size before sealing)`, POP_TRAFFIC = 'See this traffic',
  POP_LOG_ONLY = 'Log only keeps the metadata and the request and response headers; no bodies, only their sizes',
  RULES_FALLBACK = 'Whatever the other classes do not match',
  TECH_PROBLEM = 'Problem', TECH_ANSWER = 'Server answer'

// 表注行(都在卡里)
export const NOTE_LATER = 'Changes affect only calls that start later; stored data is not deleted',
  NOTE_NO_CALLS = 'No calls yet', NOTE_PARTIAL = 'The per-class numbers could not all be read',
  NOTE_READ_ONLY = 'Levels cannot be changed on this machine; shown only',
  NOTE_FILE_BAD = 'The storage settings cannot be read: until they are fixed, every call is stored in full',
  NOTE_FILE_SOME = (n) => `The storage settings have ${n} mistake${n === 1 ? '' : 's'}: ${n === 1 ? 'that entry is' : 'those entries are'} stored in full`,
  FILE_NONE = 'No settings file yet: every class is stored in full', FILE_FIX = 'Fix or delete this file, then refresh'

// 最近的修改
export const LAST_CHANGE = 'Last change', NO_CHANGE = 'No changes yet',
  SOURCE_WORD = Object.freeze({ cli: 'from the terminal', board: 'from the board', file: 'in the settings file' })

// 改级别:确认框(只对这两类改成只记日志)与回执
export const ASK_LOG_TITLE = 'Change to log only?', ASK_LOG_OK = 'Change to log only', CANCEL = 'Cancel',
  ASK_LOG = Object.freeze({
    llm: 'Later model calls are logged only: the request and reply content is not stored, and these calls are not in replay. What is already stored is not affected.',
    'token-count': 'Later token counts are logged only: the request and reply content is not stored, so replay shows only how many there were, not the counted tokens. What is already stored is not affected.',
  }),
  RCPT_CHANGED = (a, b) => `${a} → ${b} · applies to calls that start from now`, RCPT_ALREADY = (k) => `Already ${k}`,
  RCPT_STALE = 'The setting on this machine changed; this is the new plan', RCPT_NOT_CHANGED = 'Not changed',
  RCPT_READ_ONLY = 'The board is running read-only right now; nothing was changed',
  RCPT_OFFLINE = 'Cannot reach the trocar service; nothing was changed'

export const RETRY = 'Retry'

// 价格页
export const PRICE_NOTE = 'Estimated cost = usage × the unit prices here; a local estimate, not a bill · USD per million tokens',
  PRICE_READ_ONLY = 'Read-only on the board; to change a price, edit the price table',
  PRICE_FROM = (p) => `From ${p}`, PRICE_DEFAULT = 'Using trocar\'s built-in default unit prices',
  COL_KEY = 'Model name contains', COL_IN = 'input', COL_OUT = 'output', COL_WRITE = 'cache write', COL_READ = 'cache read',
  PRICE_TABLE = 'The price table', PRICE_BAD_SHAPE = 'The price table has the wrong shape',
  UNPRICED_AS_OF = 'as of', UNPRICED_SESSIONS = (n) => `used in at least ${n} sessions`,
  UNPRICED_NONE = 'Every model in use has a unit price', UNPRICED_NO_MODEL = 'no model name',
  COPY_TEMPLATE = 'Copy template',
  TEMPLATE_HINT = 'Replace the four nulls with USD per million tokens: input, output, cache write, cache read. Takes effect after a page refresh.',
  TECH_MATCH = 'An exact model-name row wins; otherwise the longest key contained in the model name. Matching is on the model name only, not the vendor.',
  TECH_WRITE_ONE = 'Cache write has one unit price; when a vendor prices by cache duration, the estimate still uses this one price.',
  TECH_PRICING_PATH = 'The server reads the file named by the TROCAR_PRICING environment variable, or its default location when unset. The board only reads it; edit the file, then refresh the page.'

// 外观页
export const THEME_SYSTEM = 'System', THEME_LIGHT = 'Light', THEME_DARK = 'Dark',
  THEME_UNSTORABLE = 'This browser does not allow saving the choice; after a refresh it returns to System'
