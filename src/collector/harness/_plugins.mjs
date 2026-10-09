// _plugins.mjs — the in-process trust plugins (RFC 4.6 §身份与信任「进程内插件:有界例外」, D37④) and the launch shims
// (4.6 Kimi row): their sources live in plugins/<harness>/ and shims/<command>, and install writes them with this
// user's CA file (and the plugins' marker directory) filled in. The plugin sources are checked statically and run
// against stubs by test/collector/harness/plugins.test.mjs (T13); the shim is run by its harness's test. The Windows
// .cmd shims and launchers of 4.8's opt-in items (§6.3 / §2.4) used to be templates here too; they are arch/win32's
// own (src/collector/arch/win32/shims.mjs) — the layering rules keep arch/ off harness/.
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


// asight's own plugin directory needs a manifest so Node's lookup stops there and never lands on someone else's; it is
// anonymous on purpose: dsh puts the name / version of every plugin's manifest into the requests it sends
// (dsh_plugin_packages), and a name without a version makes every request fail (4.6 dsh row, lab ⑤).
export const ANONYMOUS_MODULE_MANIFEST = '{"type":"module"}\n'
