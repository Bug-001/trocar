// labels/common.mjs — the strings that keep invariant 4 honest (estimates, unknowns, non-verbatim values). One place, so a
// screen cannot word the same caveat two ways. Keyed by closed sets that belong to asight itself, never by a harness-defined
// code (those carry their own words from the server, 1.5 §数据规则). Screen-only labels live in labels/<screen>.mjs.
export const L = {
  NULL: '—/NULL', USAGE_MISSING: 'usage not returned', NOT_KNOWN: 'unknown',
  COMP_EST: 'breakdown is an estimate (by character share)', SAMPLED: 'sampled',
  STRUCT_EST: 'structural estimate', LOCAL_EST: '≈ estimated cost', NO_PRICE: 'no price table',
  PRICE_APPROX_WHY: 'This model has no key of its own in the price table, so this is an estimate: it uses the longest key that appears in its name. For an exact price, add its full model name to the price table (pricing.json / ASIGHT_PRICING).',
  VERBATIM: 'verbatim', TITLE_SOURCE: 'The title comes from the agent\'s own local records. It is a convenience, not captured bytes',
  PRE_D40: 'Captured before bodies were kept: only its length was stored', LOG_ONLY: 'log only',
}
// the label of a price found through a family key rather than the model's own: names the key it came from
export const priceApprox = (key) => `estimate from price key ${key}`

// the default hover legend of each fidelity mark (1.5 §标记): every mark says its own reason; a screen may pass a
// sharper one. The kinds are asight's own closed set — never a harness-defined code.
export const MARK_TIP = Object.freeze({
  est: 'Estimate: local unit price × usage, or tokens counted from characters',
  inf: 'Inferred from timing, names or a heuristic',
  struct: 'Estimated from the size and structure of the content, not a number from the provider. The exact value is in technical details',
  part: 'Incomplete: this is not all of it',
  'null-provider': 'The provider did not return this number',
  'null-price': 'No unit price for this model',
  'null-na': 'Does not apply',
  unknown: 'unknown',
})

// the 采集状态 sentences (1.5 §采集状态 table), keyed by `health.state` of the C.3 document plus the board's own read states.
// `s` = the health object; `W` words a timestamp. No subject: a caller that shows it somewhere unnamed prefixes it itself.
export const HEALTH_WORDS = Object.freeze({
  ok: (s, W) => `✓ capturing · since ${W(s.since)}`,
  failing: (s, W, items) => `! capture has problems${items && items.length ? `: ${items.join('; ')}` : s.n != null ? `: ${s.n}` : ''}`,
  off: (s, W) => `○ off · since ${W(s.since)}`,
  'not-running': (s, W) => `✗ stopped · last record ${W(s.since)}${s.signal ? ` · by ${s.signal}` : ''}`,
  'not-responding': (s, W) => `✗ not responding · last heartbeat ${W(s.since)}`,
  unknown: (s) => `? unknown${s.reason ? `: ${s.reason}` : ''}`,
  residue: (s) => `– not installed · ${s.n != null ? `${s.n} changes` : 'changes'} left behind`,
  'not-installed': () => '– not installed',
})
export const HEALTH_READ = Object.freeze({
  unrecognized: (state) => `? unknown capture health (${state})`,
  unreadable: (why) => `? capture health could not be read: ${why}`,
  stale: (at) => `? not refreshed · as of ${at}`,
  loading: '? reading',
  partial: ' · partly unreadable',
  agents: (n) => `${n} agent${n === 1 ? ' is' : 's are'} not fully captured`,
  others: (n) => `${n} other problem${n === 1 ? '' : 's'} open`,
  groups: (n) => `${n} failure group${n === 1 ? '' : 's'} in the last 24 hours`,
})
