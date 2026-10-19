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
