// marker.mjs (src/off) — undo by marker, for when the install manifest is lost or cannot be read (RFC 1.6 R3 「按标记撤销」, 4.6 §安装清单与卸载).
// With a manifest, `off` undoes what the manifest lists. Without one it must still work, so it finds asight's changes by asight's own marks, at the
// places each harness's entry lives (MARKER_PATHS, data), and undoes only those:
//   block        a sentinel block `# >>> asight collector >>> … # <<< asight collector <<<` in a dotenv file; the user's lines asight put out of effect
//                with `#asight-collector-off# ` come back
//   line         a line with the sentinel comment `# asight collector: …` that points under ~/.asight (the Kimi PATH line, the dsh patch row)
//   json-value   a JSON string that points under ~/.asight (a CC / Z-Code trust key): the value asight replaced comes back from the NEWEST backup of that
//                file (R2), one key at a time — never the whole file (1.6 R2); no value in the backup, the key goes
//   owned-file   a plugin or shim asight wrote (its sentinel in it, or exactly asight's own plugin manifest)
// Nothing else is touched, and no byte of a file outside those marks changes. The result says `undone-by-marker` (the code `off` records and the
// receipt shows, 1.6 R3). Not done here, said in the docs: a combined bundle (no manifest, so nobody can say who holds it — `uninstall` removes it with the
// CA), and a harness at a home the default places do not name (CODEX_HOME, XDG_CONFIG_HOME …). Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { SENTINEL, OFF_PREFIX } from './text-edit.mjs'
import { getPath, setKey, removeKey } from './json-text.mjs'
import { writeDurable, editTarget, removeEmptyDirs, readOrNull } from './fsutil.mjs'
import { backupsOf } from './backup.mjs'
import { asightHome } from './paths.mjs'
import { CODE_OFF } from './names.mjs'

const RC_FILES = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin'] // where the Kimi installer's PATH line, and so asight's, can be
const PLUGIN_MANIFEST = '{"type":"module"}\n' // the anonymous package.json of asight's dsh plugin directory (collector/harness/_plugins.mjs: ANONYMOUS_MODULE_MANIFEST)

/** Where each harness's entries are, relative to HOME. `how` says what asight's mark looks like there (see the header); `eachDir` + `file`: the file in
 *  every subdirectory of a directory (Hermes profiles). The plan of 1.6 / 4.6 §身份与信任 is the authority; a harness not listed here has no marker undo. */
export const MARKER_PATHS = Object.freeze({
  'claude-code': [{ how: 'json-value', file: '.claude/settings.json', keys: ['env', 'NODE_EXTRA_CA_CERTS'] }],
  codex: [{ how: 'block', file: '.codex/.env' }],
  hermes: [{ how: 'block', file: '.hermes/.env' }, { how: 'block', eachDir: '.hermes/profiles', file: '.env' }],
  opencode: [{ how: 'owned-file', file: '.config/opencode/plugins/asight-ca.js' }],
  'deepseek-dsh': [{ how: 'line', file: '.dsh/cordis.patch.yml', yaml: true }, { how: 'owned-file', file: '.asight/collector/plugins/dsh/index.js' }, { how: 'owned-file', file: '.asight/collector/plugins/dsh/package.json', exact: PLUGIN_MANIFEST }],
  'kimi-code': [...RC_FILES.map((f) => ({ how: 'line', file: f })), { how: 'owned-file', file: '.asight/collector/bin/kimi' }],
  'z-code': [{ how: 'json-value', file: '.zcode/cli/config.json', keys: ['network', 'caCertFile'] }],
})

const BLOCK_OPEN = `# >>> ${SENTINEL} >>>`
const BLOCK_CLOSE = `# <<< ${SENTINEL} <<<`
const LINE_MARK = `# ${SENTINEL}: `
const under = (v, root) => typeof v === 'string' && v.startsWith(root + path.sep)
const utf8Of = (b) => (b == null ? null : b.toString('utf8'))
const stripOffPrefix = (t) => t.split('\n').map((l) => (l.startsWith(OFF_PREFIX) ? l.slice(OFF_PREFIX.length) : l)).join('\n') // only at a line start, where asight put it

// the lines of `t` with their offsets: [{ at, line, next }] (next = the offset after the line's own newline)
function linesOf(t) { const out = []; for (let at = 0; at < t.length;) { const e = t.indexOf('\n', at); const end = e < 0 ? t.length : e; out.push({ at, line: t.slice(at, end), next: e < 0 ? t.length : e + 1 }); at = e < 0 ? t.length : e + 1 } return out }

// asight's block in a dotenv text: from its open line to its close line; a block whose close line the user deleted ends at the last variable line under
// asight's home that follows the open line directly. → [{ from, to }] offsets
function blocksIn(t, root) {
  const ls = linesOf(t), out = []
  for (let i = 0; i < ls.length; i++) {
    if (!ls[i].line.startsWith(BLOCK_OPEN)) continue
    let j = i + 1
    while (j < ls.length && ls[j].line.trimEnd() !== BLOCK_CLOSE && /^[A-Za-z_]\w*=/.test(ls[j].line) && under(ls[j].line.slice(ls[j].line.indexOf('=') + 1).trimEnd(), root)) j++ // trimEnd: a CRLF file's lines end in \r
    out.push({ from: ls[i].at, to: j < ls.length && ls[j].line.trimEnd() === BLOCK_CLOSE ? ls[j].next : (ls[j - 1] || ls[i]).next })
    i = j
  }
  return out
}
const lineHits = (t, root) => linesOf(t).filter((l) => l.line.includes(LINE_MARK) && l.line.includes(root + path.sep))

// the candidate files of a spec for this home: [{ file, spec }]
function candidates(home, harness, fs) {
  const out = []
  for (const spec of MARKER_PATHS[harness]) {
    if (spec.eachDir) {
      let names = []
      try { names = fs.readdirSync(path.join(home, spec.eachDir)).sort() } catch { /* no such directory */ }
      for (const n of names) out.push({ file: path.join(home, spec.eachDir, n, spec.file), spec })
    } else out.push({ file: path.join(home, spec.file), spec })
  }
  return out
}

/** What asight's own marks say it changed for these harnesses (`ids` null: all), without a manifest: `[{ harness, path, how, detail }]`, in the order to
 *  undo them (values and blocks, then lines, then plugins and shims). Reads only; a file it cannot read or parse is planned only if a mark is in it. */
export function planByMarker({ home, ids = null, fs = nodeFs }) {
  const root = asightHome(home)
  const plan = []
  for (const harness of Object.keys(MARKER_PATHS)) {
    if (ids && !ids.includes(harness)) continue
    for (const { file, spec } of candidates(home, harness, fs)) {
      let t
      try { t = utf8Of(readOrNull(fs, file)) } catch { continue }
      if (t == null) continue
      const add = (detail) => plan.push({ harness, path: file, how: spec.how, detail })
      if (spec.how === 'block') {
        const commented = t.split('\n').filter((l) => l.startsWith(OFF_PREFIX)).length
        const blocks = blocksIn(t, root)
        if (blocks.length || commented) add({ blocks: blocks.length, commented })
      } else if (spec.how === 'line') {
        const hits = lineHits(t, root)
        if (hits.length) add({ lines: hits.map((h) => h.line), yaml: !!spec.yaml })
      } else if (spec.how === 'json-value') {
        let v
        try { v = getPath(JSON.parse(t), spec.keys) } catch { continue }
        if (under(v, root)) add({ keys: spec.keys, value: v })
      } else if (spec.how === 'owned-file' && (spec.exact ? t === spec.exact : t.includes(SENTINEL))) add(spec.exact ? { exact: spec.exact } : {})
    }
  }
  const rank = { 'json-value': 0, block: 0, line: 1, 'owned-file': 2 }
  return plan.sort((a, b) => rank[a.how] - rank[b.how])
}

// one plan item undone; → { result, ...what happened } (result: undone-by-marker | already-clean | left-unparsable | error)
function undoOne(item, home, fs) {
  const root = asightHome(home)
  const done = (extra = {}) => ({ result: CODE_OFF.undoneByMarker, ...extra })
  let file
  try { file = editTarget(item.path, fs) } catch (e) { return { result: 'error', reason: String((e && e.message) || e) } }
  const buf = readOrNull(fs, file)
  if (buf == null) return { result: 'already-clean' }
  const t = buf.toString('utf8'), mode = fs.statSync(file).mode & 0o777
  const put = (out) => writeDurable(file, out, mode, fs)
  if (item.how === 'owned-file') {
    if (!((item.detail || {}).exact ? t === item.detail.exact : t.includes(SENTINEL))) return { result: 'already-clean' } // not asight's (any more): a plan is never trusted over the file
    fs.rmSync(file, { force: true })
    const dirs = [path.dirname(item.path)] // the directory it was in, and, inside asight's collector dir, the ones above it that are empty now (outermost first)
    for (let d = path.dirname(dirs[0]); under(d, path.join(root, 'collector')); d = path.dirname(d)) dirs.unshift(d)
    removeEmptyDirs(dirs, fs)
    return done({ removed: true })
  }
  if (item.how === 'block') {
    let out = t
    const blocks = blocksIn(t, root)
    for (const b of blocks.reverse()) out = out.slice(0, b.from) + out.slice(b.to)
    const restored = out.split('\n').filter((l) => l.startsWith(OFF_PREFIX)).length
    out = stripOffPrefix(out)
    if (out === t) return { result: 'already-clean' }
    put(out)
    return done({ blocks: blocks.length, restored })
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
  // json-value: the value asight replaced comes back from the newest backup of this file, this key only; none there → the key goes
  const keys = item.detail.keys
  let doc
  try { doc = JSON.parse(t) } catch { return { result: 'left-unparsable' } }
  if (!under(getPath(doc, keys), root)) return { result: 'already-clean' }
  const saved = backupsOf({ home, file: item.path, fs }).at(-1) || null
  let prior = null
  if (saved) { try { const v = getPath(JSON.parse(readOrNull(fs, saved).toString('utf8')), keys); if (typeof v === 'string' && !under(v, root)) prior = v } catch { /* a backup that is not JSON holds no value */ } }
  put(prior != null ? setKey(t, keys, prior).text : removeKey(t, keys).text)
  return done(prior != null ? { restored_from: saved, value: prior } : { removed: true, ...(saved ? { backup: saved } : {}) })
}

/** Undoes a plan from planByMarker, item by item; one that fails does not stop the rest. → [{ harness, path, how, result, … }] with `result`
 *  `undone-by-marker` (the code), `already-clean` (nothing of asight's was there any more), `left-unparsable` (a JSON file that no longer parses: untouched) or
 *  `error` (+ `reason`). Backups are left where they are: whether to remove them is `off`'s call (R2). */
export function undoByMarker(plan, { home, fs = nodeFs }) {
  return plan.map((item) => {
    try { return { harness: item.harness, path: item.path, how: item.how, ...undoOne(item, home, fs) } } catch (e) { return { harness: item.harness, path: item.path, how: item.how, result: 'error', reason: String((e && e.message) || e) } }
  })
}
