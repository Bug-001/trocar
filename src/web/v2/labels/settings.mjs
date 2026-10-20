// labels/settings.mjs — the 设置 screens' fixed words (1.11): card names, the disk-use words, the price page and the
// appearance page. One word per meaning (1.5 §词表); nothing here is keyed by a harness id, a host or an endpoint
// (invariant 3 — those arrive with the data).

// 卡名 (the page head carries only the screen's name; these are the cards under it)
export const CARD_DISK = 'Disk', CARD_PRICE = 'Unit prices', CARD_UNPRICED = 'Models without a unit price', CARD_THEME = 'Theme'

// 磁盘卡
export const DISK_TOTAL = 'Used by trocar', DISK_PER_DAY = 'Estimated growth per day', AS_OF = 'as of',
  CAPTURE_PAGE_LINE = 'Each agent\'s switch, the named items and the local network environment are on the capture page', CAPTURE_PAGE_HREF = '#/capture',
  BAD_FILES = (n) => `${n} capture file problem${n === 1 ? '' : 's'} when read`, BAD_FILES_SHOW = 'Show which', READ_FAIL = 'Could not read this page'

// 磁盘上的文件(技术细节)
export const FILES_SEAL_RATIO = 'Sealed compression ratio', ESTIMATE = 'estimate', FILES_SEAL_NONE = 'No readable sealed files',
  FILES_READ_PROBLEMS = 'Read problems'

// 保存什么卡(只读:改级别的控件归 PR 5 C9;终端里的改法写在技术细节)
export const CARD_CLASSES = 'What is stored', CLASSES_AS_OF = 'Counts as of',
  WINDOWS = Object.freeze([{ value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }, { value: 'all', label: 'All' }]),
  COL_CLASS = 'Class', COL_KEEP = 'Level', COL_CALLS = 'Calls', COL_STORED = 'Stored', COL_RULES = 'Matches',
  KEEP_NAME = Object.freeze({ full: 'Everything', log: 'Log only' }), NO_CLASS = 'No class recorded',
  CLASSES_FILE = 'Settings file'

export const RETRY = 'Retry'

// 价格页
export const PRICE_NOTE = 'Estimated cost = usage × the unit prices here; a local estimate, not a bill · USD per million tokens · read-only on the board; to change a price, edit the price table',
  PRICE_FROM = (p) => `From ${p}`, PRICE_DEFAULT = 'Using trocar\'s built-in default unit prices',
  COL_KEY = 'Model name contains', COL_IN = 'input', COL_OUT = 'output', COL_WRITE = 'cache write', COL_READ = 'cache read',
  PRICE_READ_FAIL = 'Could not read the price table', PRICE_BAD_SHAPE = 'The price table has the wrong shape',
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
