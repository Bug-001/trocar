// manifest.mjs — the install manifest, version 2 (RFC 1.6 R2 / R3, 4.6 §安装清单与卸载, D39③): ~/.asight/collector/install-manifest.json (0600).
//   version          2. A manifest of a version this build does not know is handed back flagged `unsupported`, never normalized and never
//                    saved over (a build that does not know what the fields mean must not rewrite them).
//   entries          every user file asight changed: {kind, harness, path, existed_before, mode, pre_sha256, post_sha256, backup,
//                    undo_by_hand, ops, prior_value, installed_at, created_dirs, …} — `kind` says how to undo it (KNOWN_KINDS),
//                    `backup` is the path of the copy saved before the change (1.6 R2; null for a file asight created), `undo_by_hand`
//                    is one sentence on taking it out without node (R3). The user's file is never copied INTO the manifest.
//   files            files asight owns (CA, trust files, plugins, the unit): kind `owned-file`, undone by removing them.
//   confirmed_paths  the files the operator has confirmed `on` may change (1.6 R6; Task 6 writes it).
//   kept_backups     [{path, backup, reason, at}] — backups `off` kept because the user changed the file after asight did (1.6 R2).
//   liveness         what `off` needs to judge whether a running agent may have loaded asight's entry (4.6 撤销顺序; Task 4 writes it).
// A version 1 manifest (before D39) reads as version 2 with `upgraded_from: 1`: kind, `backup: null` and undo_by_hand filled in memory;
// the file on disk stays version 1 until something saves it. Imports only node:* and src/off (0.1 §2).
import nodeFs from 'node:fs'
import path from 'node:path'
import { readOrNull, writeDurable } from './fsutil.mjs'
import { SENTINEL, OFF_PREFIX } from './text-edit.mjs'

export const MANIFEST = 'install-manifest.json'
export const manifestPath = (dir) => path.join(dir, MANIFEST)
export const MANIFEST_VERSION = 2
/** The version of the undo side: bumped whenever the manifest's shape or the rules of undoing change (a new item kind, a new step). It is the number in the first lines of the
 *  generated ~/.asight/bin/asight-off, which `asight doctor` compares with the current one (1.6 R3, V35); every `on` writes the copy again, so a bump costs nothing. */
export const OFF_VERSION = 3 // 3: entries carry `scope` ('agent' | 'user' | 'machine', 1.6 §1.7) and the Windows opt-in kinds of 4.8 §2.4 — a copy written by 2 undoes none of them.
// (The plan gives Task 9(b) the collector's five kinds and this file's first bump, and Task 14 the `scope` field with the opt-in kinds; whichever of the two branches lands first, their merge takes the higher number.)

/** The kinds of item this build can undo (the `legacy-*` ones are the old capture's ledger, 1.6 §4, written by `on` on a platform without the
 *  new collector; the `optin-*` ones are the Windows opt-in items of 4.8 §2.4, written by applyOptIn with `scope`, undone inline by
 *  src/off/win32-optin.mjs's UNDO_BY_KIND — except the machine-level ones: their undo is the elevated step, `off` hands back the command).
 *  An item of any other kind is left alone by `off` and listed (unknownItems). */
export const KNOWN_KINDS = Object.freeze(['json-key', 'text', 'owned-file', 'legacy-clash-block', 'legacy-launch-agent', 'legacy-env', 'legacy-ca', 'legacy-cc-steer',
  'optin-user-path', 'optin-shortcut', 'optin-cert-user', 'optin-vscode', 'optin-zcode', 'optin-claude-policy', 'optin-machine-path', 'optin-machine-shortcut', 'optin-cert-machine'])

/** The opt-in kinds alone (4.8 §2.4): ledgered with `scope` ('user' | 'machine'); the undo of each is UNDO_BY_KIND's, and `undo_by_hand` never
 *  names a per-entry command — the agent's switch is the only undo there is (1.6 §1.7, V64). The machine-level three (4.8 §2.4's last column)
 *  are the ones whose undo is an elevated step, never inline. */
export const OPTIN_KINDS = Object.freeze(KNOWN_KINDS.filter((k) => k.startsWith('optin-')))
export const OPTIN_MACHINE_KINDS = Object.freeze(['optin-machine-path', 'optin-machine-shortcut', 'optin-cert-machine'])

export const newManifest = (now = new Date()) => ({ version: MANIFEST_VERSION, created_at: now.toISOString(), complete: false, engine_port: null, planned: [], confirmed_paths: [], kept_backups: [], liveness: {}, dirs: [], files: [], entries: [] })

// a path as a shell would want it in a command a person types: bare when it is plain, single-quoted otherwise
const shellWord = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${String(p).replace(/'/g, "'\\''")}'`)

/** One sentence: what to do by hand, with no node, to take this item out (R3). What the item's writer recorded in `undo_by_hand` is used for
 *  a kind this build does not know; for a `legacy-*` kind the writer is expected to record its own, and the fallback only says where. */
export function undoByHand(e) {
  const where = e.path
  const created = e.existed_before === false ? `; asight created this file, so delete the file when nothing else is in it` : ''
  if (e.kind === 'json-key') {
    const keys = (e.keys || []).join('.')
    if (e.prior_value != null) return `edit ${where}: set ${keys} back to ${JSON.stringify(e.prior_value)}${created}`
    const top = Number.isInteger(e.existing_depth) && e.existing_depth < (e.keys || []).length - 1 ? `, then delete ${e.keys.slice(0, e.existing_depth + 1).join('.')} if it is now empty (asight created it)` : ''
    return `edit ${where}: delete the key ${keys}${top}${created}`
  }
  if (e.kind === 'text' && e.vars) {
    return `edit ${where}: delete the lines from "# >>> ${SENTINEL} >>>" to "# <<< ${SENTINEL} <<<", then remove the prefix "${OFF_PREFIX}" from any line that has it${created}`
  }
  if (e.kind === 'text') {
    return `edit ${where}: delete the line ${JSON.stringify(e.line)}${e.format === 'yaml-list' ? ' (write [] after the key if the list is empty then)' : ''}${created}`
  }
  if (e.kind === 'owned-file') return `rm ${shellWord(where)}`
  if (OPTIN_KINDS.includes(e.kind)) return `${where}: an opt-in item (${e.kind}); the undo is the agent's switch — "asight off ${e.harness ?? '<harness>'}" takes it out (there is no per-entry undo, 1.6 §1.7)`
  if (typeof e.undo_by_hand === 'string' && e.undo_by_hand) return e.undo_by_hand
  if (KNOWN_KINDS.includes(e.kind)) return `${where}: change asight made for the old capture (${e.kind}); undo it with "asight off"`
  return `${where}: this item is of kind ${JSON.stringify(e.kind ?? null)}, which this build does not know; use the asight that wrote it ("asight off"), or look at ${where} and the manifest's entry for it`
}

/** The command that puts a file back as it was before asight, from the backup of it (R2), and what it costs; null when there is no backup (asight made the file). Plain `cp`: an
 *  existing file keeps its own mode and owner, and the user chooses to run it — asight never writes a backup over a user's file by itself (D28). */
export function restoreByHand(e) {
  if (!e || typeof e.backup !== 'string' || e.backup === '') return null
  return { backup: e.backup, command: `cp ${shellWord(e.backup)} ${shellWord(e.real_path || e.path)}`, loses: 'puts the whole file back as it was before asight, so every change made to it since is lost' }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// every item has a kind and an undo_by_hand, every manifest the v2 top-level fields; what is there is never replaced
function completeManifest(m) {
  m.version = MANIFEST_VERSION
  if (!Array.isArray(m.confirmed_paths)) m.confirmed_paths = []
  if (!Array.isArray(m.kept_backups)) m.kept_backups = []
  if (!isPlainObject(m.liveness)) m.liveness = {}
  for (const e of Array.isArray(m.entries) ? m.entries : []) {
    if (!isPlainObject(e)) continue
    if (e.kind == null) e.kind = e.format ? 'text' : 'json-key' // a JSON entry of a version 1 manifest carried no kind
    if (e.backup === undefined) e.backup = null
    if (e.scope === undefined) e.scope = OPTIN_KINDS.includes(e.kind) ? (OPTIN_MACHINE_KINDS.includes(e.kind) ? 'machine' : 'user') : 'agent' // 1.6 §1.7: what the item reaches — a manifest of before the field reads everything automatic as 'agent' (the opt-in kinds only ever came with it)
    if (!e.undo_by_hand) e.undo_by_hand = undoByHand(e)
  }
  for (const f of Array.isArray(m.files) ? m.files : []) {
    if (!isPlainObject(f)) continue
    if (f.kind == null) f.kind = 'owned-file'
    if (!f.undo_by_hand) f.undo_by_hand = undoByHand(f)
  }
  return m
}

const unsupportedVersion = (v) => !Number.isInteger(v) || v < 1 || v > MANIFEST_VERSION

// What a manifest of a version this build reads must look like before anything uses it: the lists it names are lists of the right items. A file that parses as JSON but
// has another shape (`{"version":2}`, `entries: {}`, `entries: [null]`, `files: null`) is not the manifest asight wrote — it is as unusable as one that does not parse, and
// the callers treat it the same way (an error to say, then asight's own marks), instead of crashing half-way through an undo with the routing already off (R3, R11).
// A version-1 manifest may lack a list (it is then empty); a version-2 one is written with `entries` and `files` always (newManifest), so a missing one is damage.
function checkShape(m, v, name) {
  const need = (key, item, required) => {
    if (m[key] === undefined && !required) { m[key] = []; return }
    if (!Array.isArray(m[key])) throw new Error(`${name} is not an install manifest this build can use: \`${key}\` is ${m[key] === undefined ? 'missing' : `not a list (${m[key] === null ? 'null' : typeof m[key]})`}`)
    const bad = m[key].findIndex((x) => (item === 'object' ? !isPlainObject(x) : typeof x !== 'string'))
    if (bad >= 0) throw new Error(`${name} is not an install manifest this build can use: \`${key}[${bad}]\` is not ${item === 'object' ? 'an object' : 'a string'}`)
  }
  if (m.entries === undefined && m.files === undefined) throw new Error(`${name} is not an install manifest this build can use: it lists neither \`entries\` nor \`files\``)
  need('entries', 'object', v >= MANIFEST_VERSION)
  need('files', 'object', v >= MANIFEST_VERSION)
  need('watched', 'object', false)
  need('dirs', 'string', false)
}

/** Text → manifest. A version 1 text is upgraded (`upgraded_from: 1`); a version this build does not know comes back as parsed, flagged
 *  `unsupported: true`, untouched. Throws what JSON.parse throws, or an Error for JSON that is not an object or whose lists are not the lists of a manifest. */
export function parseManifest(text, name = MANIFEST) {
  const m = JSON.parse(text)
  if (!isPlainObject(m)) throw new Error(`${name} is not a manifest (a JSON object)`)
  const v = m.version === undefined ? 1 : m.version
  if (unsupportedVersion(v)) return { ...m, unsupported: true }
  checkShape(m, v, name)
  if (v < MANIFEST_VERSION) m.upgraded_from = v
  return completeManifest(m)
}

/** The manifest in the file `file` (the install manifest, or the old capture's ledger ~/.asight/legacy-manifest.json: the same format), or null when there is none. Never writes. */
export function readManifestAt(file, fs = nodeFs) {
  const b = readOrNull(fs, file)
  return b == null ? null : parseManifest(b.toString('utf8'), file)
}

/** The manifest in `dir`, or null when there is none. Never writes. */
export function readManifest(dir, fs = nodeFs) {
  return readManifestAt(manifestPath(dir), fs)
}

/** Writes the manifest to `file` (atomic, durable, 0600; the directory above it is made 0700 when it is not there). Items pushed without a kind or an undo_by_hand get them first (in the
 *  caller's object too). Refuses a manifest of a version this build does not know: it would write version 2 shapes over data it cannot read. */
export function saveManifestAt(file, m, fs = nodeFs) {
  if (m.unsupported || unsupportedVersion(m.version)) throw new Error(`the manifest ${file} is version ${JSON.stringify(m.version)}; this build reads versions 1 and ${MANIFEST_VERSION} and will not write over it (use the asight that wrote it, or "asight off")`)
  completeManifest(m)
  const { upgraded_from: _read, ...out } = m // a fact about the read, not part of the manifest
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeDurable(file, JSON.stringify(out, null, 2) + '\n', 0o600, fs)
}

/** Writes the install manifest in `dir`. */
export function saveManifest(dir, m, fs = nodeFs) {
  saveManifestAt(manifestPath(dir), m, fs)
}

/** Items (entries and files) whose kind this build does not know, as [{path, kind}]: `off` leaves them and says so (R3). */
export function unknownItems(m) {
  return [...(Array.isArray(m.entries) ? m.entries : []), ...(Array.isArray(m.files) ? m.files : [])]
    .filter((it) => !KNOWN_KINDS.includes(it && it.kind))
    .map((it) => ({ path: it && it.path, kind: it && it.kind != null ? it.kind : null }))
}
