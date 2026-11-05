// marker.mjs (src/off) — undo by marker, for when the install manifest is lost or cannot be read (RFC 1.6 R3 「按标记撤销」, 4.6 §安装清单与卸载).
// With a manifest, `off` undoes what the manifest lists. Without one it must still work, so it finds trocar's changes by trocar's own marks, at the
// places each harness's entry lives (MARKER_PATHS, data), and undoes only those:
//   block        a sentinel block `# >>> trocar collector >>> … # <<< trocar collector <<<` in a dotenv file; the user's lines trocar put out of effect
//                with `#trocar-collector-off# ` come back key by key, as the journal's undo does (D48②: a key the user set while on keeps their value)
//   line         a line with the sentinel comment `# trocar collector: …` that points under ~/.trocar (the Kimi PATH line, the dsh patch row)
//   json-value   a JSON string that points under ~/.trocar (a CC / Z-Code trust key), or, at a proxy key `on` writes on macOS / Windows (DOOR_ROUTES),
//                one of trocar's doors (door-value.mjs: a loopback URL on a door port ingress.json records; that record unreadable, none is judged a
//                door and a note says so): the value trocar replaced comes back from the NEWEST backup of that file (R2), one key at a time — never the
//                whole file (1.6 R2); no value in the backup, the key goes
//   owned-file   a plugin or shim trocar wrote (its sentinel in it, or exactly trocar's own plugin manifest), or a switch file `on` wrote for a harness
//                (paths.mjs switchFileIn: in trocar's own tree, so trocar's by where it is, whatever it holds; a link there goes, never what it points at)
// Nothing else is touched, and no byte of a file outside those marks changes. The result says `undone-by-marker` (the code `off` records and the
// receipt shows, 1.6 R3). Not done here, said in the docs: a combined bundle (no manifest, so nobody can say who holds it — `uninstall` removes it with the
// CA), and an install-phase entry at a home the default places do not name. A `route` place (what `on` writes on macOS / Windows) is resolved as `on`
// resolved it: its variable (XDG_CONFIG_HOME, CODEX_HOME, HERMES_HOME) and the per-user folders (loc.mjs dirsFor) followed. Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { SENTINEL, BLOCK_OPEN, BLOCK_END, LINE_MARK, restoreOffLines } from './text-edit.mjs'
import { foldsEnvNames } from './env-names.mjs'
import { getPath, setKey, removeKey, parseJsonText, unreadableJson, markLen } from './json-text.mjs'
import { writeDurable, editTarget, removeEmptyDirs, readOrNull } from './fsutil.mjs'
import { backupsOf } from './backup.mjs'
import { trocarHome, collectorIn, switchFileIn } from './paths.mjs'
import { CODE_OFF } from './names.mjs'
import { decodeText, encodeText, CHARSETS, WHY_TEXT } from './text-codec.mjs'
import { resolveLoc, dirsFor } from './loc.mjs'
import { doorPorts, isDoorValue, loopbackUrl } from './door-value.mjs'

const RC_FILES = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin'] // where the Kimi installer's PATH line, and so trocar's, can be
const PLUGIN_MANIFEST = '{"type":"module"}\n' // the anonymous package.json of trocar's dsh plugin directory (collector/harness/_plugins.mjs: ANONYMOUS_MODULE_MANIFEST)

/** The class-1 routes `on` writes on macOS / Windows whose bytes carry trocar's sentinel (4.11 P5): a plugin-file route's folder (`dir`, a <loc>, loc.mjs)
 *  and file `name`, a dotenv-block route's `file` (a <loc>). The descriptor's route takes its place from here, so the marker undo looks where `on`
 *  wrote — one copy of the place, and the copy trocar-off needs no collector tree to know it. */
const HERMES_ENV = { perOs: { darwin: { base: 'home', dir: '.hermes', env: 'HERMES_HOME', path: '.env' }, win32: { base: 'localAppData', dir: 'hermes', env: 'HERMES_HOME', path: '.env' } } }
export const ROUTE_PLACES = Object.freeze({
  opencode: Object.freeze({ dir: Object.freeze({ base: 'home', dir: '.config', env: 'XDG_CONFIG_HOME', path: 'opencode/plugins' }), name: 'trocar.js' }),
  codex: Object.freeze({ file: Object.freeze({ base: 'home', dir: '.codex', env: 'CODEX_HOME', path: '.env' }) }),
  hermes: Object.freeze({ file: Object.freeze(HERMES_ENV) }),
})
/** The json-key routes `on` writes a door into on macOS / Windows (4.11 §2.3): the file (`file`, a <loc>; or `select`: the entry a meta file's `idKey`
 *  names in the directory `dir`) and the keys that hold the door (`proxyKeys`). The descriptor's route takes these from here, so the marker undo looks
 *  where `on` wrote, at the keys it wrote — one copy of each. */
const CC_SETTINGS = { base: 'home', dir: '.claude', env: 'CLAUDE_CONFIG_DIR', path: 'settings.json' }
const CLAUDE_3P = (base) => ({ base, path: 'Claude-3p/configLibrary' })
export const DOOR_ROUTES = Object.freeze({
  'claude-code': Object.freeze({
    settings: Object.freeze({ file: CC_SETTINGS, proxyKeys: [['env', 'HTTPS_PROXY'], ['env', 'https_proxy']] }),
    library: Object.freeze({ select: { dir: { perOs: { darwin: CLAUDE_3P('appSupport'), win32: CLAUDE_3P('localAppData') } }, meta: '_meta.json', idKey: 'appliedId', createIfNone: true }, proxyKeys: [['egressProxyPacUrl']] }),
  }),
  'kimi-code': Object.freeze({ vscode: Object.freeze({ file: { base: 'appSupport', path: 'Code/User/settings.json' }, proxyKeys: [['http.proxy']] }) }),
  'z-code': Object.freeze({ 'cli-config': Object.freeze({ file: { base: 'home', path: '.zcode/cli/config.json' }, proxyKeys: [['network', 'httpProxy']] }) }),
})
const URL_IN_TEXT = /https?:\/\/[^\s"'`,{}[\]\\]+/g // the URLs in a text that does not parse as JSON, each judged as a value would be
const doorAt = (h) => Object.values(DOOR_ROUTES[h]).map((route) => ({ how: 'json-value', route, door: true, os: ['darwin', 'win32'] }))

/** Where each harness's entries are, relative to HOME (`route`: a ROUTE_PLACES place, resolved against the environment and per-user folders off runs in). `how` says what trocar's mark looks like there (see the header); `eachDir` + `file`: the file in
 *  every subdirectory of a directory (Hermes profiles). The plan of 1.6 / 4.6 §身份与信任 is the authority; a harness not listed here has no marker undo. */
export const MARKER_PATHS = Object.freeze({
  'claude-code': [{ how: 'json-value', file: '.claude/settings.json', keys: ['env', 'NODE_EXTRA_CA_CERTS'] }, ...doorAt('claude-code')],
  codex: [{ how: 'block', file: '.codex/.env' }, { how: 'block', route: ROUTE_PLACES.codex }],
  hermes: [{ how: 'block', file: '.hermes/.env' }, { how: 'block', route: ROUTE_PLACES.hermes }, { how: 'block', eachDir: '.hermes/profiles', file: '.env' }],
  opencode: [{ how: 'owned-file', file: '.config/opencode/plugins/trocar-ca.js' }, { how: 'owned-file', route: ROUTE_PLACES.opencode }],
  'deepseek-dsh': [{ how: 'line', file: '.dsh/cordis.patch.yml', yaml: true }, { how: 'owned-file', file: '.trocar/collector/plugins/dsh/index.js' }, { how: 'owned-file', file: '.trocar/collector/plugins/dsh/package.json', exact: PLUGIN_MANIFEST }],
  'kimi-code': [...RC_FILES.map((f) => ({ how: 'line', file: f })), { how: 'owned-file', file: '.trocar/collector/bin/kimi' }, ...doorAt('kimi-code')],
  'z-code': [{ how: 'json-value', file: '.zcode/cli/config.json', keys: ['network', 'caCertFile'] }, ...doorAt('z-code')],
  pi: [{ how: 'owned-file', file: '.pi/agent/extensions/trocar-ca.js' }],
})

const under = (v, root) => typeof v === 'string' && v.startsWith(root + path.sep)
// The text of a file by what its bytes prove (4.6「文件的编码」, text-codec.mjs): { text, charset } | { why }. A U+FEFF at offset 0 (the mark) is
// before the first line, not part of it: linesOf starts after it, so a block or a line at the top of a marked file is found and the mark stays.
const readText = (b) => { const d = decodeText(b); return d.ok ? { text: d.text, charset: d.charset } : { why: d.why } }
// whether trocar's sentinel is in bytes that prove no form: looked for as each form trocar writes would hold it, so a file the user saved in another
// encoding after `on` is still said (left-unreadable), not passed over as clean
const markedIn = (b) => CHARSETS.some((cs) => b.includes(encodeText(SENTINEL, cs)))

// the lines of `t` with their offsets: [{ at, line, next }] (next = the offset after the line's own newline)
function linesOf(t) { const out = []; for (let at = markLen(t); at < t.length;) { const e = t.indexOf('\n', at); const end = e < 0 ? t.length : e; out.push({ at, line: t.slice(at, end), next: e < 0 ? t.length : e + 1 }); at = e < 0 ? t.length : e + 1 } return out }

// trocar's block in a dotenv text: from its open line over its variable lines to its close line (whatever the values: a CA path under trocar's home, the
// door's URL); a block whose close line the user deleted ends at the last variable line under trocar's home that follows the open line directly.
// → [{ from, to }] offsets
const isVar = (l) => /^[A-Za-z_]\w*=/.test(l)
const isClose = (l) => l.trimEnd() === BLOCK_END // trimEnd: a CRLF file's lines end in \r
function blocksIn(t, root) {
  const ls = linesOf(t), out = []
  for (let i = 0; i < ls.length; i++) {
    if (!ls[i].line.startsWith(BLOCK_OPEN)) continue
    let j = i + 1
    while (j < ls.length && !isClose(ls[j].line) && isVar(ls[j].line)) j++
    if (j >= ls.length || !isClose(ls[j].line)) { j = i + 1; while (j < ls.length && isVar(ls[j].line) && under(ls[j].line.slice(ls[j].line.indexOf('=') + 1).trimEnd(), root)) j++ }
    out.push({ from: ls[i].at, to: j < ls.length && isClose(ls[j].line) ? ls[j].next : (ls[j - 1] || ls[i]).next })
    i = j
  }
  return out
}
const lineHits = (t, root) => linesOf(t).filter((l) => l.line.includes(LINE_MARK) && l.line.includes(root + path.sep))

// the entry a select route names: <dir>/<id>.json, id = the meta file's idKey (one plain file name, nothing outside the directory); none → []
function selected(sel, ctx, fs) {
  const dir = resolveLoc(sel.dir, ctx)[0]
  if (!dir) return []
  let id
  try { const r = readText(readOrNull(fs, path.join(dir, sel.meta))); id = (parseJsonText(r.text) || {})[sel.idKey] } catch { return [] }
  return typeof id === 'string' && id !== '' && !/^\.+$/.test(id) && path.basename(id) === id && !/[\\/]/.test(id) ? [path.join(dir, `${id}.json`)] : []
}

// the candidate files of a spec for this home, each file once per kind of mark (a route place and a fixed path can name the same one; a door key
// and a trust key can share a file): [{ file, spec }]
function candidates(home, harness, fs, env, platform) {
  const out = [], seen = new Set()
  const ctx = { os: platform, home, env, dirs: dirsFor(platform, home, env) }
  const push = (file, spec) => { const k = `${spec.door ? 'door' : ''}\0${file}`; if (!seen.has(k)) { seen.add(k); out.push({ file, spec }) } }
  for (const spec of MARKER_PATHS[harness]) {
    if (spec.os && !spec.os.includes(platform)) continue
    if (spec.route) for (const at of spec.route.select ? selected(spec.route.select, ctx, fs) : spec.route.dir ? resolveLoc(spec.route.dir, ctx).map((d) => path.join(d, spec.route.name)) : resolveLoc(spec.route.file, ctx)) push(at, spec)
    else if (spec.eachDir) {
      let names = []
      try { names = fs.readdirSync(path.join(home, spec.eachDir)).sort() } catch { /* no such directory */ }
      for (const n of names) push(path.join(home, spec.eachDir, n, spec.file), spec)
    } else push(path.join(home, spec.file), spec)
  }
  push(switchFileIn(collectorIn(trocarHome(home)), harness), { how: 'owned-file', ours: true }) // every harness: only one on a switch-file route ever has one
  return out
}

/** What trocar's own marks say it changed for these harnesses (`ids` null: all), without a manifest: `[{ harness, path, how, detail }]`, in the order to
 *  undo them (values and blocks, then lines, then plugins and shims). Reads only; a file it cannot read or parse is planned only if a mark is in it.
 *  `notes` gets a sentence for each loopback proxy value it could not judge (ingress.json unreadable): left, and said. */
export function planByMarker({ home, ids = null, fs = nodeFs, env = process.env, platform = process.platform, notes = [] }) {
  const root = trocarHome(home)
  const plan = []
  let ports // the door ports, read once when a door key is looked at
  for (const harness of Object.keys(MARKER_PATHS)) {
    if (ids && !ids.includes(harness)) continue
    for (const { file, spec } of candidates(home, harness, fs, env, platform)) {
      let b
      try { b = readOrNull(fs, file) } catch { continue }
      if (b == null) continue
      const add = (detail) => plan.push({ harness, path: file, how: spec.how, detail })
      const read = readText(b)
      if (read.why) { if (markedIn(b)) add({ unreadable: read.why }); continue }
      const t = read.text
      if (spec.how === 'block') {
        const off = restoreOffLines(t, null, foldsEnvNames(platform)) // the user's lines trocar put out of effect, read as the undo reads them
        const commented = off.restored + off.prior_left.length
        const blocks = blocksIn(t, root)
        if (blocks.length || commented) add({ blocks: blocks.length, commented })
      } else if (spec.how === 'line') {
        const hits = lineHits(t, root)
        if (hits.length) add({ lines: hits.map((h) => h.line), yaml: !!spec.yaml })
      } else if (spec.how === 'json-value') {
        let doc
        try { doc = parseJsonText(t) } catch { doc = undefined }
        if (!spec.door) { if (doc !== undefined) { const v = getPath(doc, spec.keys); if (under(v, root)) add({ keys: spec.keys, value: v }) } continue }
        ports = ports || doorPorts(collectorIn(root), fs)
        const unknown = (where) => notes.push(`${file}: ${where} names a loopback proxy, and trocar cannot tell whether it is one of its doors (${ports.why}); it was left as it is`)
        if (doc === undefined) { // no longer parses: a door URL anywhere in the text plans it, and the undo leaves it and says so (R3: exit 1)
          const urls = t.match(URL_IN_TEXT) || []
          if (ports.ports && urls.some((u) => isDoorValue(u, ports.ports))) add({ keys: null, door: true })
          else if (ports.why && urls.some(loopbackUrl)) unknown('the file')
          continue
        }
        for (const keys of spec.route.proxyKeys) {
          const v = getPath(doc, keys)
          if (ports.ports && isDoorValue(v, ports.ports)) add({ keys, door: true }) // the value itself is not kept: a door URL holds its token
          else if (ports.why && loopbackUrl(v)) unknown(keys.join('.'))
        }
      } else if (spec.how === 'owned-file' && (spec.ours || (spec.exact ? t === spec.exact : t.includes(SENTINEL)))) add(spec.ours ? { ours: true } : spec.exact ? { exact: spec.exact } : {})
    }
  }
  const rank = { 'json-value': 0, block: 0, line: 1, 'owned-file': 2 }
  return plan.sort((a, b) => rank[a.how] - rank[b.how])
}

// one plan item undone; → { result, ...what happened } (result: undone-by-marker | already-clean | left-unparsable | left-unreadable | error)
function undoOne(item, home, fs) {
  const root = trocarHome(home)
  const done = (extra = {}) => ({ result: CODE_OFF.undoneByMarker, ...extra })
  if ((item.detail || {}).ours) { // the switch file: the path itself goes (a link, not what it names); nothing in it is read
    try { fs.lstatSync(item.path) } catch { return { result: 'already-clean' } }
    fs.rmSync(item.path, { force: true })
    removeEmptyDirs([path.dirname(item.path)], fs)
    return done({ removed: true })
  }
  let file
  try { file = editTarget(item.path, fs) } catch (e) { return { result: 'error', reason: String((e && e.message) || e) } }
  const buf = readOrNull(fs, file)
  if (buf == null) return { result: 'already-clean' }
  const read = readText(buf)
  if (read.why) return markedIn(buf) ? { result: 'left-unreadable', why: read.why, reason: `${item.path} can no longer be read as text trocar may write back: ${WHY_TEXT[read.why]} (${read.why}); trocar did not touch it, and its mark is still in it` } : { result: 'already-clean' }
  const t = read.text, mode = fs.statSync(file).mode & 0o777
  const put = (out) => writeDurable(file, encodeText(out, read.charset), mode, fs) // in the form the file has
  if (item.how === 'owned-file') {
    if (!((item.detail || {}).exact ? t === item.detail.exact : t.includes(SENTINEL))) return { result: 'already-clean' } // not trocar's (any more): a plan is never trusted over the file
    fs.rmSync(file, { force: true })
    const dirs = [path.dirname(item.path)] // the directory it was in, and, inside trocar's collector dir, the ones above it that are empty now (outermost first)
    for (let d = path.dirname(dirs[0]); under(d, path.join(root, 'collector')); d = path.dirname(d)) dirs.unshift(d)
    removeEmptyDirs(dirs, fs)
    return done({ removed: true })
  }
  if (item.how === 'block') {
    let out = t
    const blocks = blocksIn(t, root)
    for (const b of blocks.reverse()) out = out.slice(0, b.from) + out.slice(b.to)
    // the user's lines trocar put out of effect, key by key as the journal's undo does (D48②): a key the user set while on keeps their value
    const r = restoreOffLines(out, null, foldsEnvNames(process.platform))
    out = r.text
    if (out === t && !r.prior_left.length) return { result: 'already-clean' }
    if (out !== t) put(out)
    return done({ blocks: blocks.length, restored: r.restored, ...(r.prior_left.length ? { prior_left: r.prior_left } : {}) })
  }
  if (item.how === 'line') {
    const hits = lineHits(t, root).reverse()
    if (!hits.length) return { result: 'already-clean' }
    let out = t
    for (const h of hits) out = out.slice(0, h.at) + out.slice(h.next)
    if ((item.detail || {}).yaml && out.trim() === '') { fs.rmSync(file, { force: true }); removeEmptyDirs([path.dirname(item.path)], fs); return done({ lines: hits.length, deleted: true }) } // dsh will not start on an empty patch file; with no row there is nothing to read
    put(out)
    return done({ lines: hits.length })
  }
  // json-value: the value trocar replaced comes back from the newest backup of this file, this key only; none there → the key goes
  const keys = item.detail.keys, at = keys ? keys.join('.') : 'its proxy keys' // null: found in a file that did not parse, key unknown
  let ours = (v) => under(v, root)
  if (item.detail.door) { const p = doorPorts(collectorIn(root), fs); if (!p.ports) return { result: 'error', reason: `${item.path}: ${at} was not undone: ${p.why}` }; ours = (v) => isDoorValue(v, p.ports) }
  let doc
  try { doc = parseJsonText(t) } catch (e) { return { result: 'left-unparsable', reason: unreadableJson(item.path, t, e, `trocar's value under ${at}`) } }
  if (!keys) return { result: 'error', reason: `${item.path} changed while off read it: run off again` } // planned as not parsing, parses now: judged key by key next time
  if (!ours(getPath(doc, keys))) return { result: 'already-clean' }
  // the newest backup whose value here is not trocar's own (`on` saves the file before each key it writes, so a newer one can hold trocar's first key)
  let saved = null, prior = null
  for (const b of backupsOf({ home, file: item.path, fs }).reverse()) {
    let v
    try { const s = readText(readOrNull(fs, b)); v = s.why ? undefined : getPath(parseJsonText(s.text), keys) } catch { /* a backup that is not JSON holds no value */ }
    if (typeof v === 'string' && ours(v)) continue
    saved = b
    if (typeof v === 'string') prior = v
    break
  }
  put(prior != null ? setKey(t, keys, prior).text : removeKey(t, keys).text)
  return done(prior != null ? { restored_from: saved, value: prior } : { removed: true, ...(saved ? { backup: saved } : {}) })
}

/** Undoes a plan from planByMarker, item by item; one that fails does not stop the rest. → [{ harness, path, how, result, … }] with `result`
 *  `undone-by-marker` (the code), `already-clean` (nothing of trocar's was there any more), `left-unparsable` (a JSON file that no longer parses: untouched), `left-unreadable` (a marked file whose bytes prove no encoding: untouched) or
 *  `error` (+ `reason`). Backups are left where they are: whether to remove them is `off`'s call (R2). */
export function undoByMarker(plan, { home, fs = nodeFs }) {
  return plan.map((item) => {
    try { return { harness: item.harness, path: item.path, how: item.how, ...undoOne(item, home, fs) } } catch (e) { return { harness: item.harness, path: item.path, how: item.how, result: 'error', reason: String((e && e.message) || e) } }
  })
}
