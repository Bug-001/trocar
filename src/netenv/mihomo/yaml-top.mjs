// yaml-top.mjs — a top-level scalar of a YAML file, read in memory (RFC 4.7 §3.2). The files the Verge adapter reads (verge.yaml, config.yaml, the runtime clash-verge.yaml, profiles.yaml) hold the
// controller's secret, the subscription's address and the user's nodes, and the project takes no YAML library: so only the handful of keys 4.7 §3.2 lists are looked at, by the line they are on,
// and nothing else of the file is parsed, kept or shown. A key that is absent, empty, `null`, or nested (indented) reads as null. Nothing is imported.

/** The value of `key:` at the start of a line: unquoted, a trailing ` # comment` of a plain scalar dropped; null when there is none. */
export function topKey(text, key) {
  if (typeof text !== 'string') return null
  const m = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'm').exec(text)
  if (!m) return null
  let v = m[1]
  if (v.startsWith('"')) { const e = /^"((?:[^"\\]|\\.)*)"/.exec(v); v = e ? e[1].replace(/\\(.)/g, '$1') : v } else if (v.startsWith("'")) { const e = /^'((?:[^']|'')*)'/.exec(v); v = e ? e[1].replace(/''/g, "'") : v } else v = v.replace(/[ \t]+#.*$/, '')
  return v === '' || v === 'null' || v === '~' ? null : v
}
/** `true` / `false` as YAML spells them; null for anything else (absent, or some other text). */
export function topBool(text, key) { const v = topKey(text, key); return v === 'true' ? true : v === 'false' ? false : null }
/** An integer; null for anything else. */
export function topInt(text, key) { const v = topKey(text, key); return v !== null && /^\d{1,9}$/.test(v) ? Number(v) : null }
