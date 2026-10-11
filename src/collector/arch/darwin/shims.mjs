// shims.mjs (arch/darwin) — the POSIX launch shims of the opt-in items (RFC 4.9 §2.4 · §6.3; the twin of arch/win32/shims.mjs, plan
// Task 14's darwin half): templates in `shims/*.sh.tmpl` beside this file, rendered by renderShTemplate. The template's slots are
// filled, every slot it names must be given, and a half-filled shim is refused, never written mangled — the win32 twin's rule. A value
// that would break the single-quoted shell word — a single quote, a newline, a control character — is refused the same way (a double
// quote and a space are fine: the shim's own quoting carries them, the PATH line's double quotes carry the directory). darwin-collector
// territory (the layering rules keep arch/ off harness/: these are 4.9's items, not a harness's own shim — the 4.6 Kimi row's CA-only
// POSIX shim stays in harness/shims/). The templates are DATA to the unit tests (test/collector/arch/darwin/optin.test.mjs); the lab
// runs the real thing (MA4).
import fs from 'node:fs'

export const SHIM_SOURCES = new URL('./shims/', import.meta.url)

const SH_SLOTS = Object.freeze({ proxy: '__ASIGHT_PROXY__', caFile: '__ASIGHT_CA_FILE__', realBinary: '__ASIGHT_REAL_BINARY__' })

/** renderShTemplate(name, { proxy?, caFile?, realBinary? }) → the shim's text. The slots a template names must all be given (a
 *  half-filled shim is refused); a value holding a character the single-quoted shell word must not receive verbatim (a `'`, a newline,
 *  a control character) is refused too. Line endings are the file's own (LF): a POSIX sh reads no other. */
export function renderShTemplate(name, { proxy = null, caFile = null, realBinary = null } = {}) {
  const src = fs.readFileSync(new URL(name, SHIM_SOURCES), 'utf8')
  let out = src
  const values = { proxy, caFile, realBinary }
  for (const [k, slot] of Object.entries(SH_SLOTS)) {
    if (values[k] == null) continue
    const v = String(values[k])
    if (/['\r\n\x00-\x1f]/.test(v)) throw new Error(`sh template ${name}: the ${k} value holds a character a single-quoted shell word must not receive verbatim (${JSON.stringify(v)})`)
    if (!out.includes(slot)) throw new Error(`sh template ${name}: it has no ${slot} slot, so a ${k} was given for nothing`)
    out = out.replaceAll(slot, v)
  }
  const missed = Object.entries(SH_SLOTS).filter(([, slot]) => out.includes(slot)).map(([k, slot]) => `${slot} (${k})`)
  if (missed.length) throw new Error(`sh template ${name}: ${missed.join(', ')} not filled`)
  return out
}
