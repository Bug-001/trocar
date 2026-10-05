// _plugins.mjs — the in-process trust plugins (RFC 4.6 §身份与信任「进程内插件:有界例外」, D37④): their sources live
// in plugins/<harness>/, and install writes them with this user's CA file and marker directory filled in. The sources
// are checked statically and run against stubs by test/collector/harness/plugins.test.mjs (T13).
import fs from 'node:fs'

export const PLUGIN_SOURCES = new URL('./plugins/', import.meta.url)
const SLOTS = { caFile: "'__ASIGHT_CA_FILE__'", markerDir: "'__ASIGHT_MARKER_DIR__'" }

export function renderPlugin(rel, { caFile, markerDir }) {
  const src = fs.readFileSync(new URL(rel, PLUGIN_SOURCES), 'utf8')
  for (const [k, slot] of Object.entries(SLOTS)) if (src.split(slot).length !== 2) throw new Error(`plugin ${rel}: expected exactly one ${slot} (${k})`)
  return src.replace(SLOTS.caFile, JSON.stringify(caFile)).replace(SLOTS.markerDir, JSON.stringify(markerDir))
}

// asight's own plugin directory needs a manifest so Node's lookup stops there and never lands on someone else's; it is
// anonymous on purpose: dsh puts the name / version of every plugin's manifest into the requests it sends
// (dsh_plugin_packages), and a name without a version makes every request fail (4.6 dsh row, lab ⑤).
export const ANONYMOUS_MODULE_MANIFEST = '{"type":"module"}\n'
