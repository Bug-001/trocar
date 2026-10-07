// clash.mjs (src/off) — taking asight's route out of Clash Verge / mihomo, and asking the core whether it is gone (RFC 1.6 §4 「旧 MITM 达到 off 保证的条件」, §6 「入账」「核对生效」;
// D28 only the sentinel block goes; D29 the runtime is reloaded by payload and the live proxy list is read back). `asight off` (src/off/legacy.mjs) and `asight desktop off` (src/capture/
// desktop-steer.mjs) run THIS code: there is one undo, not two. Moved here from src/capture/desktop-steer.mjs without a change of behaviour — the steer's `on` side (scriptBlock, injectScript,
// spliceRuntime) stays there, and the old names are re-exported from it. Imports only node:* and src/off (0.1 §2: the standalone ~/.asight/bin/asight-off is made of this directory).
//   pure          stripBlock · stripRuntime · stripMergeLegacy — the text of a file with asight's route taken out, every other byte as it was

export const PROXY_NAME = 'atrace-mitm'
export const DESKTOP_RULE = `AND,((PROCESS-PATH-REGEX,(?i)Application Support/Claude/claude-code),(DOMAIN,api.anthropic.com)),${PROXY_NAME}`
// the sentinel INNER text is comment-syntax-agnostic; Script.js (JavaScript) writes it after `//`, a runtime YAML after `#` (a `//` line is NOT a YAML comment, it would break the parse)
export const MARK_BEGIN = '>>> atrace desktop capture (managed by asight desktop) >>>'
export const MARK_END = '<<< atrace desktop capture <<<'
/** The line in Script.js that says the block is there. */
export const SCRIPT_BEGIN = `// ${MARK_BEGIN}`

const clashEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ── pure transforms ────────────────────────────────────────────────────────────────────────────

/** Strips any prior atrace block (between the sentinels, inclusive of its own line) from JS OR YAML — it matches on the inner marker text, so it catches the `//` and the `#` form. */
export function stripBlock(text) {
  const re = new RegExp(`\\n?[^\\n]*${clashEscape(MARK_BEGIN)}[\\s\\S]*?${clashEscape(MARK_END)}[^\\n]*`, 'g')
  return text.replace(re, '')
}

/** Removes EVERY atrace route from a runtime yaml: our sentinel-marked splice, AND the unmarked copy the durable Script.js puts there at each Verge regen (serde_yaml block style, `- name: atrace-mitm`
 *  + `- <DESKTOP_RULE>`). Stripping only the sentinel form was D29's bug: after any regen, on() spliced a second proxy of the same name (mihomo 400 "duplicate name") and off() pushed a config that
 *  still routed into the MITM. Only the top-level `proxies:` items named EXACTLY atrace-mitm and `rules:` items equal to DESKTOP_RULE go; every other byte stays. */
export function stripRuntime(yaml) {
  const lines = stripBlock(yaml).split('\n')
  const tail = lines.at(-1) === '' ? lines.pop() : null // keep the final newline out of any item
  const out = []
  let section = null, listIndent = null, item = null
  // the item's OWN `name` only (the dash line, or a key at the item's key column) — never a nested `name:` deeper inside some other proxy (e.g. plugin-opts), which would delete the user's proxy
  const nameIs = `name:\\s*(['"]?)${clashEscape(PROXY_NAME)}\\1\\s*(?:[,}]|$)`
  const isOurProxy = ([head, ...rest]) => {
    if (new RegExp(`^\\s*-\\s+(?:\\{\\s*)?${nameIs}`).test(head)) return true
    const inline = /^(\s*-\s+)\S/.exec(head) // `- key: v` → keys sit where `key` starts
    const keyCol = inline ? inline[1].length : (rest.find((l) => l.trim()) || '').search(/\S/) // bare `-`
    return rest.some((l) => l.length - l.trimStart().length === keyCol && new RegExp(`^\\s*${nameIs}`).test(l))
  }
  const isOurRule = (l) => new RegExp(`^\\s*-\\s+(['"]?)${clashEscape(DESKTOP_RULE)}\\1\\s*$`).test(l)
  const flush = () => { if (item && !isOurProxy(item)) out.push(...item); item = null }
  for (const ln of lines) {
    const top = /^[^\s#-][^:]*:/.test(ln)
    if (top) { flush(); section = ln.split(':')[0]; listIndent = null; out.push(ln); continue }
    const dash = /^(\s*)-(?:\s|$)/.exec(ln)
    if (dash && listIndent === null) listIndent = dash[1].length
    if (section === 'proxies') {
      if (dash && dash[1].length === listIndent) { flush(); item = [ln]; continue }
      if (item) { item.push(ln); continue }
    } else if (section === 'rules' && dash && dash[1].length === listIndent && isOurRule(ln)) continue
    out.push(ln)
  }
  flush()
  if (tail !== null) out.push(tail)
  return out.join('\n')
}

/** The demo's atrace-desktop wrote `prepend-proxies:` / `prepend-rules:` blocks into Merge.yaml (inert on Verge 2.5.1). Strip that legacy shape too, so an off leaves a clean Merge.yaml. */
export function stripMergeLegacy(yaml) {
  return yaml
    .replace(/\n?prepend-proxies:\n(?:[ \t]*-[^\n]*\n?)+/g, '\n')
    .replace(/\n?prepend-rules:\n(?:[ \t]*-[^\n]*\n?)+/g, '\n')
}
