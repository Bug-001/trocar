// _plugins.mjs — the in-process trust plugins (RFC 4.6 §身份与信任「进程内插件:有界例外」, D37④) and the launch shims
// (4.6 Kimi row): their sources live in plugins/<harness>/ and shims/<command>, and install writes them with this
// user's CA file (and the plugins' marker directory) filled in. The plugin sources are checked statically and run
// against stubs by test/collector/harness/plugins.test.mjs (T13); the shim is run by its harness's test. The Windows
// .cmd shims and launchers of 4.8's opt-in items (§6.3 / §2.4) are templates in the same directory (`*.cmd.tmpl`),
// rendered by renderCmdTemplate — plain data to the unit tests, run for real on Windows.
import fs from 'node:fs'

export const PLUGIN_SOURCES = new URL('./plugins/', import.meta.url)
const SLOTS = { caFile: "'__ASIGHT_CA_FILE__'", markerDir: "'__ASIGHT_MARKER_DIR__'" }

export function renderPlugin(rel, { caFile, markerDir }) {
  const src = fs.readFileSync(new URL(rel, PLUGIN_SOURCES), 'utf8')
  for (const [k, slot] of Object.entries(SLOTS)) if (src.split(slot).length !== 2) throw new Error(`plugin ${rel}: expected exactly one ${slot} (${k})`)
  return src.replace(SLOTS.caFile, JSON.stringify(caFile)).replace(SLOTS.markerDir, JSON.stringify(markerDir))
}

export const SHIM_SOURCES = new URL('./shims/', import.meta.url)
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

// A launch shim (POSIX sh) with the CA file it sets, single-quoted for the shell.
export function renderShim(name, { caFile }) {
  const src = fs.readFileSync(new URL(name, SHIM_SOURCES), 'utf8')
  if (src.split(SLOTS.caFile).length !== 2) throw new Error(`shim ${name}: expected exactly one ${SLOTS.caFile}`)
  return src.replace(SLOTS.caFile, () => shellQuote(caFile))
}

// A Windows launch shim or launcher (.cmd, RFC 4.8 §6.3 / §2.4's opt-in items), rendered from a `*.cmd.tmpl` beside
// the POSIX shims: the template's slots are filled, every slot it names must be given, and the output gets the CRLF
// line endings a .cmd file wants (the repo copy stays LF). A value that would break the one `set "VAR=…"` line or the
// quoted binary call — a double quote, a percent sign cmd would expand, a newline — is refused, never written mangled.
const CMD_SLOTS = Object.freeze({ proxy: '__ASIGHT_PROXY__', caFile: '__ASIGHT_CA_FILE__', realBinary: '__ASIGHT_REAL_BINARY__' })
export function renderCmdTemplate(name, { proxy = null, caFile = null, realBinary = null } = {}) {
  const src = fs.readFileSync(new URL(name, SHIM_SOURCES), 'utf8')
  let out = src
  const values = { proxy, caFile, realBinary }
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

// asight's own plugin directory needs a manifest so Node's lookup stops there and never lands on someone else's; it is
// anonymous on purpose: dsh puts the name / version of every plugin's manifest into the requests it sends
// (dsh_plugin_packages), and a name without a version makes every request fail (4.6 dsh row, lab ⑤).
export const ANONYMOUS_MODULE_MANIFEST = '{"type":"module"}\n'
