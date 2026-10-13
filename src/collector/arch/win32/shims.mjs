// shims.mjs (arch/win32) — the Windows .cmd shims and launchers of the opt-in items (RFC 4.8 §6.3 / §2.4; plan Task 14, W21's shim cells):
// templates in `shims/*.cmd.tmpl` beside this file, rendered by renderCmdTemplate — the template's slots are filled, every slot it names
// must be given, and the output gets the CRLF line endings a .cmd file wants (the repo copy stays LF). A value that would break the one
// `set "VAR=…"` line or the quoted binary call — a double quote, a percent sign cmd would expand, a newline — is refused, never written
// mangled. Windows-collector territory (the layering rules keep arch/ off harness/: these are 4.8's items, not a harness's own shim —
// the POSIX launch shim of the 4.6 Kimi row stays in harness/shims/). The templates are DATA to the unit tests
// (test/collector/arch/win32/shims.test.mjs).
import fs from 'node:fs'

export const SHIM_SOURCES = new URL('./shims/', import.meta.url)

const CMD_SLOTS = Object.freeze({ proxy: '__ASIGHT_PROXY__', caFile: '__ASIGHT_CA_FILE__', realBinary: '__ASIGHT_REAL_BINARY__', markerDir: '__ASIGHT_MARKER_DIR__' })
export function renderCmdTemplate(name, { proxy = null, caFile = null, realBinary = null, markerDir = null } = {}) {
  const src = fs.readFileSync(new URL(name, SHIM_SOURCES), 'utf8')
  let out = src
  const values = { proxy, caFile, realBinary, markerDir }
  for (const [k, slot] of Object.entries(CMD_SLOTS)) {
    if (values[k] == null) continue
    const v = String(values[k])
    if (/["%\r\n]/.test(v)) throw new Error(`cmd template ${name}: the ${k} value holds a character a .cmd file must not receive verbatim (${JSON.stringify(v)})`)
    if (!out.includes(slot)) throw new Error(`cmd template ${name}: it has no ${slot} slot, so a ${k} was given for nothing`)
    out = out.replaceAll(slot, v)
  }
  // a slot still standing is a value that was not given: a half-filled shim is refused, never written
  const missed = Object.entries(CMD_SLOTS).filter(([, slot]) => out.includes(slot)).map(([k, slot]) => `${slot} (${k})`)
  if (missed.length) throw new Error(`cmd template ${name}: ${missed.join(', ')} not filled`)
  const crlf = out.replace(/\r?\n/g, '\r\n')
  if (!/^[\x20-\x7e\r\n\t]*$/.test(crlf)) throw new Error(`cmd template ${name}: the output is not plain ASCII`)
  return crlf
}

/** The per-pid launch-marker writer the kimi shim starts beside the real run (`kimi-marker.ps1` beside this file —
 *  a static, parameterised script: no slots, so it ships verbatim). The opt-in item writes it next to the shim. */
export function markerScript() {
  return fs.readFileSync(new URL('kimi-marker.ps1', SHIM_SOURCES), 'utf8')
}
