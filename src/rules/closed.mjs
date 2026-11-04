// closed.mjs (src/rules) — the rule system's closed sets and limits (RFC 5.1, 1.6 C.5). Everything that writes or reads a rule, a skip, a held
// outcome or a rule's state takes the names and numbers from here. Leaf module (0.1 §2): imports nothing.

const list = (...names) => Object.freeze(names)

/** Where a rule acts (`on`, 5.1 §规则长什么样). */
export const POSITIONS = list('request', 'response', 'ws-client', 'ws-server')
/** What happens when a rule cannot do its work (`on_error`). */
export const ON_ERROR = list('forward', 'drop')
/** `state` of a rule in `trocar query rules` (1.6 C.5). */
export const RULE_STATES = list('live', 'resting', 'waiting', 'stopped-by-off', 'limit-reached', 'process-gone', 'load-failed', 'disabled', 'tripped')
/** `outcome` of a held unit (1.6 C.5). */
export const OUTCOMES = list('released', 'released-edited', 'dropped', 'released-by-timeout', 'dropped-by-timeout', 'released-by-off', 'dropped-by-off',
  'released-by-rule-off', 'dropped-by-rule-off', 'agent-gone', 'upstream-gone', 'cut-by-off', 'cut-by-stop', 'held-lost')
/** `buffers` of a rule in `trocar query rules` (1.6 C.5). */
export const BUFFERS = list('none', 'request', 'stream', 'message', 'response')
/** `skipped.why` (5.1 §记录与标注 and the two tables of §其余规定). */
export const SKIP_WHY = list(
  'timeout', 'peer-timeout', 'queued', 'crashed', 'cooling',
  'expect-continue', 'encoding', 'not-utf8', 'too-big', 'event-too-big', 'multi-line-event', 'not-json', 'no-blocks', 'streaming', 'http10', 'edits-full', 'bad-result',
  'multi-script', 'rule-error', 'load-failed', 'audit-failed', 'no-progress', 'no-terminal',
  'pipelined', 'no-recorder', 'credentialed-hop', 'head-too-big', 'head-timeout', 'not-http', 'blind', 'ws-compressed', 'passthrough', 'gate-full',
  'gate-error', 'no-runner')
/** The action kinds the engine carries out: `rules enable` refuses the others (5.1 §引擎). Grows as the engine does. */
export const ENGINE_ACTIONS = list()

/** A file with no `max_delay_ms` (5.1 §最长延迟). */
export const DEFAULT_MAX_DELAY_MS = 200
/** Every bound a rule file is held to (5.1 §规则长什么样, §最长延迟, §隔离). */
export const LIMITS = Object.freeze({
  fileBytes: 1 << 20,
  nameBytes: 128,
  jsonDepth: 32,
  rules: 1000,
  list: 64,
  regexBytes: 4096,
  literalBytes: 256,
  indexEntries: 100_000,
  tier1Conditions: 4096,
  armedScripts: 4,
  headerGrowthBytes: 8192,
  releaseAfterMs: 86_400_000,
  delayMs: 60_000,
  maxDelayMs: 60_000,
  bodyBytes: 64 * 1024 * 1024,
  loadMs: 10_000,
  regexLoadMs: 2_000,
})
