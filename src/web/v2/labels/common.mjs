// labels/common.mjs — the strings that keep invariant 4 honest (estimates, unknowns, non-verbatim values). One place, so a
// screen cannot word the same caveat two ways. Keyed by closed sets that belong to asight itself, never by a harness-defined
// code (those carry their own words from the server, 1.5 §数据规则). Screen-only labels live in labels/<screen>.mjs.
export const L = {
  NULL: '—/NULL', USAGE_MISSING: 'usage 未返回', NOT_KNOWN: '不知道',
  COMP_EST: '组成为估算(按字符占比)', SAMPLED: '采样显示',
  STRUCT_EST: '结构估计', LOCAL_EST: '≈ 本地估价', NO_PRICE: '无价表',
  PRICE_APPROX_WHY: '这个模型在价表里没有自己的键;这个价按价表里「出现在它名字里的最长的键」算,不是这个模型的精确价格。要精确,把它的完整模型名加进价表(pricing.json / ASIGHT_PRICING)。',
  VERBATIM: '逐字', TITLE_SOURCE: '标题取自 harness 自己的本地库,是便利信息,不是采集字节',
  PRE_D40: '本条采于 D40 之前,只存了长度', LOG_ONLY: '只记日志',
}
// the label of a price found through a family key rather than the model's own: names the key it came from
export const priceApprox = (key) => `按价表键 ${key} 近似`

// the default hover legend of each fidelity mark (1.5 §标记): every mark says its own reason; a screen may pass a
// sharper one. The kinds are asight's own closed set — never a harness-defined code.
export const MARK_TIP = Object.freeze({
  est: '估算:本地单价 × 用量;按字符估的 token',
  inf: '按时间、名字或启发式推出来的',
  struct: '这是按内容大小和结构估出来的,不是服务商给的数;权威值在技术细节',
  part: '不完整:你看到的不是全部',
  'null-provider': '服务商没有返回这个数',
  'null-price': '没有这个模型的单价',
  'null-na': '不适用',
  unknown: '不知道',
})
