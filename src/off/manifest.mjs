// manifest.mjs — the install manifest, version 3 (RFC 1.6 R2 / R3, 4.6 §安装清单与卸载, D39③, D55): ~/.asight/collector/install-manifest.json (0600).
//   version          3. A manifest of a version this build does not know is handed back flagged `unsupported`, never normalized and never
//                    saved over (a build that does not know what the fields mean must not rewrite them).
//   entries          every user file asight changed: {kind, harness, path, existed_before, mode, pre_sha256, post_sha256, backup,
//                    undo_by_hand, ops, prior_value, installed_at, created_dirs, charset?, …} — `charset` (text-codec.mjs CHARSETS) only when the file is not utf8: its `ops` are offsets in the text decoded from that form — `kind` says how to undo it (KNOWN_KINDS),
//                    `backup` is the path of the copy saved before the change (1.6 R2; null for a file asight created), `undo_by_hand`
//                    is one sentence on taking it out without node (R3). The user's file is never copied INTO the manifest.
//   files            files asight owns (CA, trust files, plugins, the unit): kind `owned-file`, undone by removing them.
//   confirmed_paths  the files the operator has confirmed `on` may change (1.6 R6; Task 6 writes it).
//   kept_backups     [{path, backup, reason, at}] — backups `off` kept because the user changed the file after asight did (1.6 R2).
//   liveness         what `off` needs to judge whether a running agent may have loaded asight's entry (4.6 撤销顺序; Task 4 writes it).
//   install          null until `install` ran; then { state: 'complete' | 'partial', at, pending: [], harnesses: [] } (D55; replaces v2's `complete`).
//   ca               null, or { fp256, created_at } of the collector CA `install` minted (D55).
// Every entry and file carries `phase`: 'install' | 'on', the command that wrote it (D55①): `off` undoes phase 'on', `uninstall` the rest.
// A version 2 manifest is classified in memory (classifyV2, `upgraded_from: 2`); it stays version 2 on disk until something saves it.
// A version 1 manifest (before D39) reads as version 3 with `upgraded_from: 1`: kind, `backup: null` and undo_by_hand filled in memory;
// the file on disk stays version 1 until something saves it. Imports only node:* and src/off (0.1 §2).
import nodeFs from 'node:fs'
import path from 'node:path'
import { readOrNull, writeDurable } from './fsutil.mjs'
import { SENTINEL, OFF_PREFIX } from './text-edit.mjs'
import { TASK_NAME, RUN_KEY } from './win32.mjs' // the undo-by-hand sentences name the same task and Run value the undo touches (the equality is test/off/win32.test.mjs's)

export const MANIFEST = 'install-manifest.json'
export const manifestPath = (dir) => path.join(dir, MANIFEST)
export const MANIFEST_VERSION = 3
/** The commands that write items (D55①): every entry and file says which one wrote it. */
export const PHASES = Object.freeze(['install', 'on'])
/** The version of the undo side: bumped whenever the manifest's shape or the rules of undoing change (a new item kind, a new step). It is the number in the first lines of the
 *  generated ~/.asight/bin/asight-off, which `asight doctor` compares with the current one (1.6 R3, V35); every `on` writes the copy again, so a bump costs nothing. */
export const OFF_VERSION = 12 // 12: the copy's off reads a user's file by what its bytes prove and undoes an entry in the form its `charset` names (text-codec.mjs, absent = utf8; 4.11 P13, 2026-10-15) — a UTF-16 file is undone in UTF-16, its mark stays first, a file the user re-saved in a form that proves no encoding is left (left-unreadable, the entry stays, exit 1); a copy written by 11 decoded every file as UTF-8 and wrote a UTF-16 file back as UTF-8. 11: every item carries `phase` and the manifest is version 3 (D55①) — a copy written by 10 reads versions up to 2, so it flags a version 3 manifest `unsupported` and touches nothing (exit 1); `on` rewrites the copy. 10: the snapshot key is `identity`, the name list compiled (D51, 4.6 「判活快照」), and off adds the names agents.json holds now — a copy written by 9 reads only `signature`, so a record `on` rewrote (identity, no signature) is "not known" to it (D50②): it keeps the files without the CA and exits 1, the safe direction; `on` rewrites the copy. 9: the copy's off judges liveness on macOS and Windows (4.6 「判活快照」, 2026-10-13) — a signature null in the manifest is "not known" (kept, exit 1), macOS's table reads the executables with lsof and both keep the raw command line the folded form tables match, and a process whose environment the OS never shows may hold an extra trust file; a copy written by 8 read a null signature as "nobody holds it" and deleted a bundle a running Codex re-reads. 8: the copy's off rebuilds a gone combined bundle from THIS platform's OS roots through the collector's own reader (os-roots.mjs osRootsFor, 4.6 撤销顺序 第 2 步, 2026-10-13) — a copy written by 7 read the static PEM list on every platform, /etc/ssl/cert.pem on a Mac (4.9 §6.2 forbids it), and said nothing of a part it could not read. 7: the copy's off rebuilds a gone combined bundle from the first OS bundle of the one six-path list (pem.mjs SYSTEM_BUNDLES, 4.6 「合并包」, 2026-10-13) and says when there is none — a copy written by 6 knew three paths and said nothing. 6: the copy's off knows the desktop launcher (4.9 §6.4, 2026-10-12) — a copy written by 5 lists an optin-desktop-launcher entry as unknown and leaves the file behind. 5: the copy's off undoes darwin's opt-in items — the rc PATH line + the launch shim AND the login-keychain certificate (4.9 §2.4, the flip checklist ④) — a copy written by 4 knows neither kind, so its `off` would only list them. 4: the copy's off knows darwin — the autostart it takes out there is the LaunchAgent (launchctl bootout + the plist, the flip checklist ① of 4.9 §4), not systemd's unit; a copy written by 3 would run systemctl on a Mac. 3: the copy undoes BOTH the Windows collector's items (run-key, scheduled-task, forwarder-binary, proxy-entry, trust-entry — 4.8 §4.2, plan 9(b), audit F3) and the opt-in items with their `scope` ('agent' | 'user' | 'machine', 1.6 §1.7, plan 14) — a copy written by 2 undoes none of them
// (The plan gave Task 9(b) the collector's kinds and Task 14 the `scope` field with the opt-in kinds; the two branches landed side by side and both bumped to 3, so their merge is the union at 3.)

/** The kinds of item this build can undo. The `legacy-*` ones are the old capture's ledger (written by `on` on a platform without the
 *  new collector). The Windows collector's kinds (plan 9(b), audit F3 — they land WITH or BEFORE the flip so every entry a flipped `on` writes
 *  is a kind `off` undoes):
 *    proxy-entry · trust-entry   file edits (an agent's proxy field, a trust bundle entry): undone by the same file rule as json-key / text
 *    run-key                     the HKCU Run fallback: undone by the reg dance (src/off/win32.mjs undoRunKey)
 *    scheduled-task              the \asight\collector task: disabled by `off`, deleted by `uninstall` (undoScheduledTask)
 *    forwarder-binary            the copied kernel exe: kept while it drains (`off`), removed by `uninstall`
 *  The `optin-*` ones are the Windows opt-in items of 4.8 §2.4, written by applyOptIn with `scope`, undone inline by
 *  src/off/win32-optin.mjs's UNDO_BY_KIND — except the machine-level ones: their undo is the elevated step, `off` hands back the command.
 *  An item of any other kind is left alone by `off` and listed (unknownItems). No vpn-* kinds (D43). */
export const KNOWN_KINDS = Object.freeze(['json-key', 'text', 'owned-file', 'legacy-clash-block', 'legacy-launch-agent', 'legacy-env', 'legacy-ca', 'legacy-cc-steer',
  'proxy-entry', 'trust-entry', 'forwarder-binary', 'scheduled-task', 'run-key',
  'optin-user-path', 'optin-shortcut', 'optin-cert-user', 'optin-vscode', 'optin-zcode', 'optin-claude-policy', 'optin-machine-path', 'optin-machine-shortcut', 'optin-cert-machine',
  'optin-rc-path', 'optin-keychain-cert', 'optin-desktop-launcher',
  'system-root', 'login-env', 'json-array-item']) // D55: the CA in the user's OS store (by fingerprint), NODE_EXTRA_CA_CERTS in the login environment (per carrier), one element asight added to a JSON array (P5). Before them: the darwin opt-in kinds (4.9 §2.4): the rc PATH line + the launch shim (reference-counted), the login-keychain certificate (by SHA-256 fingerprint), and the Claude Desktop launcher of §6.4 — undone inline by src/off/darwin-optin.mjs's DARWIN_UNDO_BY_KIND
/** The kinds undone by the file rule (journal.mjs undoEntry): they carry the same shape as json-key / text (path, pre_sha256, ops). */
export const FILE_ENTRY_KINDS = Object.freeze(['json-key', 'text', 'proxy-entry', 'trust-entry'])
/** The opt-in kinds alone (4.8 §2.4): ledgered with `scope` ('user' | 'machine'); the undo of each is UNDO_BY_KIND's, and `undo_by_hand` never
 *  names a per-entry command — the agent's switch is the only undo there is (1.6 §1.7, V64). The machine-level three (4.8 §2.4's last column)
 *  are the ones whose undo is an elevated step, never inline. */
export const OPTIN_KINDS = Object.freeze(KNOWN_KINDS.filter((k) => k.startsWith('optin-')))
export const OPTIN_MACHINE_KINDS = Object.freeze(['optin-machine-path', 'optin-machine-shortcut', 'optin-cert-machine'])
/** Each OS store a system-root sits in → the v2 certificate opt-in kind whose undo takes it out (by its fingerprint / thumbprint, the same record values).
 *  classifyV2 folds the opt-ins into system-roots by this map, and the opt-in undo loops route a system-root back through it until the D55 apply/undo lands. */
export const ROOT_STORE_KIND = Object.freeze({ 'darwin-user-trust': 'optin-keychain-cert', 'win-currentuser-root': 'optin-cert-user', 'win-localmachine-root': 'optin-cert-machine' })
/** Known kinds no undo of this build takes out yet: `off` / `uninstall` list them as left, with their undo_by_hand, and keep the manifest (D38) — never skip them silently. */
export const NO_UNDO_YET = Object.freeze(['login-env', 'json-array-item'])

export const newManifest = (now = new Date()) => ({ version: MANIFEST_VERSION, created_at: now.toISOString(), install: null, ca: null, engine_port: null, planned: [], confirmed_paths: [], kept_backups: [], liveness: {}, dirs: [], files: [], entries: [] })

/** Has `install` finished (D55: `install.state`, which replaced v2's `complete`)? */
export const installComplete = (m) => !!(m && isPlainObject(m.install) && m.install.state === 'complete')
/** May the daemon start on `m`? An install that finished — or a version 2 one that was complete (classifyV2's `v2_complete`): its `on` left routing that still needs the engine. */
export const daemonMayStart = (m) => installComplete(m) || !!(m && m.v2_complete === true)
/** The entries and files of one phase. */
export const itemsOfPhase = (m, phase) => [...(Array.isArray(m && m.entries) ? m.entries : []), ...(Array.isArray(m && m.files) ? m.files : [])].filter((x) => isPlainObject(x) && x.phase === phase)

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
  if (e.kind === 'system-root') {
    if (e.store === 'win-currentuser-root') return `run: certutil -user -delstore Root ${e.thumbprint ?? '<thumbprint of the asight CA>'}`
    if (e.store === 'win-localmachine-root') return `run as administrator: certutil -delstore Root ${e.thumbprint ?? '<thumbprint of the asight CA>'}`
    return `run: security remove-trusted-cert ${e.cert_file ? shellWord(e.cert_file) : '<the asight CA file>'}, then security delete-certificate -Z ${e.thumbprint ?? '<SHA-1 of the asight CA>'} (the certificate with SHA-256 ${e.fp256 ?? 'unknown'})`
  }
  if (e.kind === 'login-env') {
    const at = (Array.isArray(e.carriers) ? e.carriers : []).map((c) => (c && c.path) || (c && [c.hive, c.key, c.name].filter(Boolean).join('\\')) || '?').join(', ')
    return `remove ${e.name ?? 'the variable'} from your login environment (${at || 'no carrier recorded'})${e.prior_value != null ? `, and set it back to ${JSON.stringify(e.prior_value)}` : ''}`
  }
  if (e.kind === 'json-array-item') return `edit ${where}: remove ${JSON.stringify(e.item)} from the list ${(e.keys || []).join('.')}${e.created_array ? ', then delete the list if it is now empty (asight created it)' : ''}`
  if (e.kind === 'run-key') {
    const at = `${e.hive ?? RUN_KEY.hive}\\${e.key ?? RUN_KEY.key}\\${e.name ?? RUN_KEY.name}`
    return e.prior ? `run: reg add ${at} /t ${e.prior.kind} /d ${JSON.stringify(e.prior.value)} /f (put your own value back, the one asight recorded)` : `run: reg delete ${at} /f`
  }
  if (e.kind === 'scheduled-task') return `run: schtasks /Change /TN ${TASK_NAME} /DISABLE (an uninstall deletes it: schtasks /Delete /TN ${TASK_NAME} /F)`
  if (e.kind === 'forwarder-binary') return `rm ${shellWord(where)} (a kernel still draining holds it: it goes when the drain ends; stop it with asight off --now)`
  if (OPTIN_KINDS.includes(e.kind)) return `${where}: an opt-in item (${e.kind}); the undo is the agent's switch — "asight off ${e.harness ?? '<harness>'}" takes it out (there is no per-entry undo, 1.6 §1.7)`
  if (typeof e.undo_by_hand === 'string' && e.undo_by_hand) return e.undo_by_hand
  if (KNOWN_KINDS.includes(e.kind)) return `${where}: change asight made for the old capture (${e.kind}); undo it with "asight off"`
  return `${where}: this item is of kind ${JSON.stringify(e.kind ?? null)}, which this build does not know; use the asight that wrote it ("asight off"), or look at ${where} and the manifest's entry for it`
}

/** The command that puts a file back as it was before asight, from the backup of it (R2), and what it costs; null when there is no backup (asight made the file). Plain `cp`: an
 *  existing file keeps its own mode and owner, and the user chooses to run it — asight never writes a backup over a user's file by itself (1.6 R2). */
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
  if (m.install === undefined) m.install = null
  if (m.ca === undefined) m.ca = null
  return m
}

// ── classifyV2: the phase of each item of a version 1 / 2 manifest (D55, 4.6 安装清单). The last use of shape matching: a v3 writer says its phase.
const CERT_OPTINS = Object.values(ROOT_STORE_KIND)
const ON_FILE_ROLES = ['unit', 'daemon-log', 'forwarder-binary']
const ON_ENTRY_KINDS = ['proxy-entry', 'run-key', 'scheduled-task', 'forwarder-binary'] // the routing and the autostart; the legacy-* kinds are the old capture's switch
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])
const isLoopbackUrl = (v) => { try { return LOOPBACK.has(new URL(v).hostname) } catch { return false } }
const namesAsightPath = (v) => /[\\/]\.asight([\\/]|$)/.test(v)
// json-key / text / trust-entry: a proxy entry records a loopback URL and no path of asight's; a trust entry records a path under ~/.asight. A Codex / Hermes
// proxy block joined into the cert block is its own entry, with only the proxy variables, so each entry is judged by its own values.
function entryPhase(e) {
  if (OPTIN_KINDS.includes(e.kind) || ON_ENTRY_KINDS.includes(e.kind) || String(e.kind).startsWith('legacy-')) return 'on'
  if (!['json-key', 'text', 'trust-entry'].includes(e.kind)) return 'install'
  const values = [e.value, ...(isPlainObject(e.vars) ? Object.values(e.vars) : [])].filter((v) => typeof v === 'string')
  return values.some(isLoopbackUrl) && !values.some(namesAsightPath) ? 'on' : 'install'
}
// the certificate opt-ins of one store are one certificate there: one system-root per store (ROOT_STORE_KIND), the earliest installed_at. The records' values
// (fingerprint, thumbprint, keychain, cert file) ride along: the opt-in undo takes the root out by them, as it took the opt-in out.
function systemRootOf(store, recs) {
  const v = (r) => (isPlainObject(r.values) ? r.values : {})
  const values = Object.assign({}, ...[...recs].reverse().map(v))
  const pick = (k) => (typeof values[k] === 'string' && values[k]) || null
  const fp256 = pick('fp256'), thumbprint = pick('thumbprint')
  const at = recs.map((r) => r.installed_at).filter((x) => typeof x === 'string').sort()[0] ?? null
  const machine = recs.some((r) => r.scope === 'machine')
  const e = { kind: 'system-root', harness: null, phase: 'install', scope: machine ? 'machine' : 'user', path: `${store}:${fp256 ?? thumbprint}`, store, fp256, thumbprint, cert_file: pick('certFile'), status: 'done', installed_at: at, backup: null, values }
  e.undo_by_hand = undoByHand(e)
  if (machine) e.elevated_command = recs.map((r) => r.elevated_command).find((c) => typeof c === 'string') ?? e.undo_by_hand
  return e
}

/** A version 1 / 2 manifest (already shaped by parseManifest) → a version 3 one, with `phase` on every item. Pure: `m` is not changed. `install` stays null (v2's
 *  `complete` goes): `on` refuses until `install` has run. The certificate opt-ins collapse into one system-root (phase install), every other opt-in is 'on'. */
export function classifyV2(m) {
  const out = structuredClone(m)
  delete out.complete
  out.install = null
  if (m.complete === true) out.v2_complete = true // the routing a v2 `on` left still needs its daemon; only `install` replaces this (daemonMayStart)
  out.ca = out.ca ?? null
  const certs = out.entries.filter((e) => isPlainObject(e) && CERT_OPTINS.includes(e.kind))
  out.entries = out.entries.filter((e) => !certs.includes(e)).map((e) => (isPlainObject(e) ? { ...e, phase: entryPhase(e) } : e))
  for (const [store, kind] of Object.entries(ROOT_STORE_KIND)) {
    const recs = certs.filter((r) => r.kind === kind)
    if (recs.length) out.entries.push(systemRootOf(store, recs))
  }
  out.files = out.files.map((f) => (isPlainObject(f) ? { ...f, phase: ON_FILE_ROLES.includes(f.role) ? 'on' : 'install' } : f))
  out.version = MANIFEST_VERSION
  return out
}

const unsupportedVersion = (v) => !Number.isInteger(v) || v < 1 || v > MANIFEST_VERSION

// What a manifest of a version this build reads must look like before anything uses it: the lists it names are lists of the right items. A file that parses as JSON but
// has another shape (`{"version":2}`, `entries: {}`, `entries: [null]`, `files: null`) is not the manifest asight wrote — it is as unusable as one that does not parse, and
// the callers treat it the same way (an error to say, then asight's own marks), instead of crashing half-way through an undo with the routing already off (R3, R11).
// A version-1 manifest may lack a list (it is then empty); a version 2 or 3 one is written with `entries` and `files` always (newManifest), so a missing one is damage.
function checkShape(m, v, name) {
  const need = (key, item, required) => {
    if (m[key] === undefined && !required) { m[key] = []; return }
    if (!Array.isArray(m[key])) throw new Error(`${name} is not an install manifest this build can use: \`${key}\` is ${m[key] === undefined ? 'missing' : `not a list (${m[key] === null ? 'null' : typeof m[key]})`}`)
    const bad = m[key].findIndex((x) => (item === 'object' ? !isPlainObject(x) : typeof x !== 'string'))
    if (bad >= 0) throw new Error(`${name} is not an install manifest this build can use: \`${key}[${bad}]\` is not ${item === 'object' ? 'an object' : 'a string'}`)
  }
  if (m.entries === undefined && m.files === undefined) throw new Error(`${name} is not an install manifest this build can use: it lists neither \`entries\` nor \`files\``)
  need('entries', 'object', v >= 2)
  need('files', 'object', v >= 2)
  need('watched', 'object', false)
  need('dirs', 'string', false)
}

/** Text → manifest. A version 1 or 2 text is classified to version 3 (classifyV2, `upgraded_from`); a version this build does not know comes back as parsed, flagged
 *  `unsupported: true`, untouched. Throws what JSON.parse throws, or an Error for JSON that is not an object or whose lists are not the lists of a manifest. */
export function parseManifest(text, name = MANIFEST) {
  const m = JSON.parse(text)
  if (!isPlainObject(m)) throw new Error(`${name} is not a manifest (a JSON object)`)
  const v = m.version === undefined ? 1 : m.version
  if (unsupportedVersion(v)) return { ...m, unsupported: true }
  checkShape(m, v, name)
  if (v === MANIFEST_VERSION) return completeManifest(m)
  return { ...classifyV2(completeManifest(m)), upgraded_from: v }
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
 *  caller's object too). Refuses a manifest of a version this build does not know: it would write version 3 shapes over data it cannot read. Refuses an item without a `phase` (D55): a writer that forgets fails its own test. */
export function saveManifestAt(file, m, fs = nodeFs) {
  if (m.unsupported || unsupportedVersion(m.version)) throw new Error(`the manifest ${file} is version ${JSON.stringify(m.version)}; this build reads versions 1 to ${MANIFEST_VERSION} and will not write over it (use the asight that wrote it, or "asight off")`)
  completeManifest(m)
  for (const it of [...m.entries, ...m.files]) {
    if (!PHASES.includes(it && it.phase)) throw new Error(`the manifest ${file} was not saved: the item ${JSON.stringify((it && it.path) ?? null)} (${it && it.kind}) has no phase (${PHASES.join(' | ')}); every writer says which command wrote it (D55)`)
  }
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
