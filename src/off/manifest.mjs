// manifest.mjs — the install manifest, version 3 (RFC 1.6 R2 / R3, 4.6 §安装清单与卸载, D39③, D55): ~/.trocar/collector/install-manifest.json (0600).
//   version          3. A manifest of a version this build does not know is handed back flagged `unsupported`, never normalized and never
//                    saved over (a build that does not know what the fields mean must not rewrite them).
//   entries          every user file trocar changed: {kind, harness, path, existed_before, mode, pre_sha256, post_sha256, backup,
//                    undo_by_hand, ops, prior_value, installed_at, created_dirs, charset?, …} — `charset` (text-codec.mjs CHARSETS) only when the file is not utf8: its `ops` are offsets in the text decoded from that form — `kind` says how to undo it (KNOWN_KINDS),
//                    `backup` is the path of the copy saved before the change (1.6 R2; null for a file trocar created), `undo_by_hand`
//                    is one sentence on taking it out without node (R3). The user's file is never copied INTO the manifest.
//   files            files trocar owns (CA, trust files, plugins, the unit): kind `owned-file`, undone by removing them.
//   confirmed_paths  the files the operator has confirmed `on` may change (1.6 R6).
//   kept_backups     [{path, backup, reason, at}] — backups `off` kept because the user changed the file after trocar did (1.6 R2).
//   liveness         what `off` needs to judge whether a running agent may have loaded trocar's entry (4.6 撤销顺序).
//   install          null until `install` ran; then { state: 'complete' | 'partial', at, pending: [], harnesses: [], code } (D55; replaces v2's `complete`); `code` = the codeId() that ran it (1.6 §5.5; a board Set up keeps it).
//   ca               null, or { fp256, created_at } of the collector CA `install` minted (D55).
// Every entry and file carries `phase`: 'install' | 'on', the command that wrote it (D55①): `off` undoes phase 'on', `uninstall` the rest.
// A version 1 or 2 manifest (before the collector model) is not read: every writing command refuses it before any write (refuseOldManifest, 4.11 ⑰).
// Imports only node:* and src/off (0.1 §2).
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { collectorDir, standalonePath } from './paths.mjs'
import { readOrNull, writeDurable } from './fsutil.mjs'
import { SENTINEL, OFF_PREFIX, BLOCK_OPEN, BLOCK_END } from './text-edit.mjs'
import { TASK_NAME, RUN_KEY } from './win32.mjs' // the undo-by-hand sentences name the same task and Run value the undo touches (the equality is test/off/win32.test.mjs's)

export const MANIFEST = 'install-manifest.json'
export const manifestPath = (dir) => path.join(dir, MANIFEST)
export const MANIFEST_VERSION = 3
/** The commands that write items (D55①): every entry and file says which one wrote it. */
export const PHASES = Object.freeze(['install', 'on'])
/** The version of the undo side: bumped whenever the manifest's shape or the rules of undoing change (a new item kind, a new step). It is the number in the first lines of the
 *  generated ~/.trocar/bin/trocar-off, which `trocar doctor` compares with the current one (1.6 R3, V35); every `on` writes the copy again, so a bump costs nothing. */
export const OFF_VERSION = 24 // 24: the copy's marker-only off looks where `on` wrote on macOS / Windows (marker.mjs ROUTE_PLACES, by the one <loc> resolver src/off/loc.mjs, the route's variable and the per-user folders followed): OpenCode's routing plugin <config>/opencode/plugins/trocar.js and the Codex / Hermes proxy blocks (Hermes's under %LOCALAPPDATA% on Windows), and it takes a block's variable lines out up to its close line whatever their values; a copy written by 23 looks only at fixed HOME paths, misses the routing plugin, and leaves a door-valued block's lines behind. 23: the copy's marker-only off knows pi's place, its extension ~/.pi/agent/extensions/trocar-ca.js (an owned file); a copy written by 22 looks in no place for pi and leaves that file behind. 22: the copy's holder judge reads the door's durable rows (door-seen.json) and the history fields `since` / `door_since` (4.11 P12): a process started after the carrier in a history nobody recorded, under a routed ancestor, or a Chromium host whose network service came through the door is a holder; a copy written by 21 reads none of them and closes the door under it. 21: the copy's door-holder judge reads `liveness.<h>.rereads` as the routes' datum alone (install writes the trust entry's as `trust_rereads`, read only by uninstall's steps 2 / 3 / 5), and step 5 runs only for harnesses whose install items this run undoes, so its off reports no process as still trusting; a copy written by 20 ORs the trust datum into the door judge and lists a Claude Desktop from before on as a holder. 20: the copy's holder judge (holders.mjs) counts every on window `liveness.<h>.windows` keeps (4.11 P12: an off → on with the door unchanged keeps the earlier windows), so a process started before a `trocar update` and still pointed at the door is a holder after the next off; a copy written by 19 counts the latest window only and closes the door under it. 19: on Windows the copy's off asks the DAEMON's resident read-only helper for the process table once and answers its three identity questions out of it (this process's for op.lock, the daemon lock's, the supervisor's) instead of starting a powershell.exe for each (D62, 1.6 §3.1: 1758 of off's 2034 ms were those four starts, measured on a Windows test machine 2026-10-19); with no daemon answering it asks the one local question and the receipt says why (D38). A copy written by 18 starts four. 18: in proxy mode (macOS / Windows) an `off` with no names no longer asks the daemon to exit — it closes the doors and the daemon idles on (D62 ⑥; `uninstall` still asks). A copy written by 17 asks for the exit, so a following `on` waits out launchd's ThrottleInterval (measured 9.7 s) and a daemon that crashes at start is respawned on the throttle instead of being left alone. 17: the copy no longer disables the login autostart — `install` owns it and `off` must not change what a reboot brings back (D61); and it reads the macOS process table with `ps` alone (`-o comm=` names the executable), never `lsof` (4.9 §5). 16: the copy prints its receipt, its plan and its refusals in English, in the layout of 1.6 §3.4 (D58), and its `--json` receipt carries appendix C.2's `harnesses:[{harness, ok, reason, undone, kept_backups}]`, `outcome` and `daemon.exits_after` — a copy written by 15 prints Chinese and a plain list of harness ids. 15: the copy's off no longer knows the optin-* kinds (D57; only v2 manifests ever held them, and every command refuses a v2 manifest, 4.11 ⑰): an optin-* item in a v3 manifest is an unknown kind, so off refuses the whole run before any write (V35) — a copy written by 14 knew them and listed such an item as left. 14: the copy's off spares every item of phase install (D55①, 1.6 §1.1 「证书一项不碰」): config keys, bundles, loader lines and plugins install placed stay, only `uninstall` takes them — a copy written by 13 spared only the root key, wrappers and pem-blocks, so its off took the other certificate carriers out and the next on ran with none. 13: the copy's off knows the collector model's kinds (4.11 P13: root-key, owned-file wrapper / switch / config-entry, text pem-block, json-array-item undone; login-env gone) and refuses, before any write, a version 1 / 2 manifest (4.11 ⑰: it names the trocar that undoes it) and a manifest holding a kind it does not know (no routing change, no bootout) — a copy written by 12 lists the new kinds as unknown and reads a v2 manifest by classifyV2, which is gone. 12: the copy's off reads a user's file by what its bytes prove and undoes an entry in the form its `charset` names (text-codec.mjs, absent = utf8; 4.11 P13, 2026-10-15) — a UTF-16 file is undone in UTF-16, its mark stays first, a file the user re-saved in a form that proves no encoding is left (left-unreadable, the entry stays, exit 1); a copy written by 11 decoded every file as UTF-8 and wrote a UTF-16 file back as UTF-8. 11: every item carries `phase` and the manifest is version 3 (D55①) — a copy written by 10 reads versions up to 2, so it flags a version 3 manifest `unsupported` and touches nothing (exit 1); `on` rewrites the copy. 10: the snapshot key is `identity`, the name list compiled (D51, 4.6 「判活快照」), and off adds the names agents.json holds now — a copy written by 9 reads only `signature`, so a record `on` rewrote (identity, no signature) is "not known" to it (D50②): it keeps the files without the CA and exits 1, the safe direction; `on` rewrites the copy. 9: the copy's off judges liveness on macOS and Windows (4.6 「判活快照」, 2026-10-13) — a signature null in the manifest is "not known" (kept, exit 1), macOS's table reads the executables with lsof and both keep the raw command line the folded form tables match, and a process whose environment the OS never shows may hold an extra trust file; a copy written by 8 read a null signature as "nobody holds it" and deleted a bundle a running Codex re-reads. 8: the copy's off rebuilds a gone combined bundle from THIS platform's OS roots through the collector's own reader (os-roots.mjs osRootsFor, 4.6 撤销顺序 第 2 步, 2026-10-13) — a copy written by 7 read the static PEM list on every platform, /etc/ssl/cert.pem on a Mac (4.9 §6.2 forbids it), and said nothing of a part it could not read. 7: the copy's off rebuilds a gone combined bundle from the first OS bundle of the one six-path list (pem.mjs SYSTEM_BUNDLES, 4.6 「合并包」, 2026-10-13) and says when there is none — a copy written by 6 knew three paths and said nothing. 6: the copy's off knows the desktop launcher (4.9 §6.4, 2026-10-12) — a copy written by 5 lists an optin-desktop-launcher entry as unknown and leaves the file behind. 5: the copy's off undoes darwin's opt-in items — the rc PATH line + the launch shim AND the login-keychain certificate (4.9 §2.4, the flip checklist ④) — a copy written by 4 knows neither kind, so its `off` would only list them. 4: the copy's off knows darwin — the autostart it takes out there is the LaunchAgent (launchctl bootout + the plist, the flip checklist ① of 4.9 §4), not systemd's unit; a copy written by 3 would run systemctl on a Mac. 3: the copy undoes BOTH the Windows collector's items (run-key, scheduled-task, forwarder-binary, proxy-entry, trust-entry — 4.8 §4.2) and the opt-in items with their `scope` ('agent' | 'user' | 'machine', 1.6 §1.7) — a copy written by 2 undoes none of them
// (Version 3 carries both the Windows collector's kinds and the `scope` field with the opt-in kinds.)

/** The kinds of item this build can undo. The `legacy-*` ones are the old capture's ledger (written by `on` on a platform without the
 *  new collector). The Windows collector's kinds (they land WITH or BEFORE the flip so every entry a flipped `on` writes
 *  is a kind `off` undoes):
 *    proxy-entry · trust-entry   file edits (an agent's proxy field, a trust bundle entry): undone by the same file rule as json-key / text
 *    run-key                     the HKCU Run fallback: undone by the reg dance (src/off/win32.mjs undoRunKey)
 *    scheduled-task              the \trocar\collector task: disabled by `off`, deleted by `uninstall` (undoScheduledTask)
 *    forwarder-binary            the copied kernel exe: kept while it drains (`off`), removed by `uninstall`
 *  An item of any other kind is left alone by `off` and listed (unknownItems). No vpn-* kinds (D43). */
export const KNOWN_KINDS = Object.freeze(['json-key', 'text', 'owned-file', 'legacy-clash-block', 'legacy-launch-agent', 'legacy-env', 'legacy-ca', 'legacy-cc-steer',
  'proxy-entry', 'trust-entry', 'forwarder-binary', 'scheduled-task', 'run-key',
  'system-root', 'json-array-item', 'root-key']) // D55: the CA in the user's OS store (by fingerprint), one element trocar added to a JSON array (P5), the root's private key in its custody backend (4.11 P13: `custody` {kind: 'keychain' | 'cng' | 'file', id} and `fp256`; uninstall takes it out last, through the injected custody's remove).
/** The kinds undone by the file rule (journal.mjs undoEntry): they carry the same shape as json-key / text (path, pre_sha256, ops). */
export const FILE_ENTRY_KINDS = Object.freeze(['json-key', 'text', 'proxy-entry', 'trust-entry', 'json-array-item'])
// The `owned-file` roles 4.11 P13 adds: `switch` (the route switch file) and `config-entry` (a config-library entry trocar created) are removed like a plugin;
// a `wrapper` (P8: `real` is where the real program was moved, `sha256` the wrapper's, `real_sha256` the program's) is undone by `uninstall` only, by putting
// the program back while the wrapper is still trocar's, else by deleting only the moved copy (undo.mjs undoWrapper).

export const newManifest = (now = new Date()) => ({ version: MANIFEST_VERSION, created_at: now.toISOString(), install: null, ca: null, engine_port: null, planned: [], confirmed_paths: [], kept_backups: [], liveness: {}, dirs: [], files: [], entries: [] })

/** Has `install` finished (D55: `install.state`, which replaced v2's `complete`)? */
export const installComplete = (m) => !!(m && isPlainObject(m.install) && m.install.state === 'complete')
/** Is there an install to route over (1.6 §1.1: refuse only with no usable root or no install record)? An install record — complete, or partial: a root
 *  store that declined or left the prompt pending still leaves the root, and the forms it cannot reach go through the doors forwarding only — and a root on
 *  record: its key in custody (`root-key`) or the CA file (`ca-cert`, Linux). A version 1 / 2 manifest is never read (4.11 ⑰). */
export const installUsable = (m) => !!(m && isPlainObject(m.install) && typeof m.install.state === 'string' && [...(Array.isArray(m.entries) ? m.entries : []), ...(Array.isArray(m.files) ? m.files : [])].some((x) => isPlainObject(x) && x.phase === 'install' && (x.kind === 'root-key' || x.role === 'ca-cert')))
/** May the daemon start on `m`? On an install it can route over (installUsable). */
export const daemonMayStart = (m) => installUsable(m)
/** The entries and files of one phase. */
export const itemsOfPhase = (m, phase) => [...(Array.isArray(m && m.entries) ? m.entries : []), ...(Array.isArray(m && m.files) ? m.files : [])].filter((x) => isPlainObject(x) && x.phase === phase)

// a path as a shell would want it in a command a person types: bare when it is plain, single-quoted otherwise
const shellWord = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${String(p).replace(/'/g, "'\\''")}'`)

/** One sentence: what to do by hand, with no node, to take this item out (R3). What the item's writer recorded in `undo_by_hand` is used for
 *  a kind this build does not know; for a `legacy-*` kind the writer is expected to record its own, and the fallback only says where. */
export function undoByHand(e) {
  const where = e.path
  const created = e.existed_before === false ? `; trocar created this file, so delete the file when nothing else is in it` : ''
  if (e.kind === 'json-key') {
    const keys = (e.keys || []).join('.')
    if (e.prior_value != null) return `edit ${where}: set ${keys} back to ${JSON.stringify(e.prior_value)}${created}`
    const top = Number.isInteger(e.existing_depth) && e.existing_depth < (e.keys || []).length - 1 ? `, then delete ${e.keys.slice(0, e.existing_depth + 1).join('.')} if it is now empty (trocar created it)` : ''
    return `edit ${where}: delete the key ${keys}${top}${created}`
  }
  if (e.kind === 'text' && e.vars) {
    return `edit ${where}: delete the lines from "# >>> ${SENTINEL} >>>" to "# <<< ${SENTINEL} <<<", then remove the prefix "${OFF_PREFIX}" from any line that has it${created}`
  }
  if (e.kind === 'text' && e.format === 'pem-block') return `edit ${where}: delete the lines from the one that starts "${BLOCK_OPEN}" to "${BLOCK_END}" at its end, and nothing else`
  if (e.kind === 'text') {
    return `edit ${where}: delete the line ${JSON.stringify(e.line)}${e.format === 'yaml-list' ? ' (write [] after the key if the list is empty then)' : ''}${created}`
  }
  if (e.kind === 'owned-file' && e.role === 'wrapper') return `if sha256 of ${shellWord(where)} is still ${e.sha256 ?? "trocar's wrapper"}: mv ${shellWord(String(e.real))} ${shellWord(where)}; otherwise: rm ${shellWord(String(e.real))} (the program was updated over the wrapper)`
  if (e.kind === 'owned-file') return `rm ${shellWord(where)}`
  if (e.kind === 'system-root') {
    if (e.store === 'win-currentuser-root') return `run: certutil -user -delstore Root ${e.thumbprint ?? '<thumbprint of the trocar CA>'}`
    if (e.store === 'win-localmachine-root') return `run as administrator: certutil -delstore Root ${e.thumbprint ?? '<thumbprint of the trocar CA>'}`
    return `run: security remove-trusted-cert ${e.cert_file ? shellWord(e.cert_file) : '<the trocar CA file>'}, then security delete-certificate -Z ${e.thumbprint ?? '<SHA-1 of the trocar CA>'} (the certificate with SHA-256 ${e.fp256 ?? 'unknown'})`
  }
  if (e.kind === 'root-key') {
    const c = isPlainObject(e.custody) ? e.custody : {}
    const how = c.kind === 'file' ? `rm ${shellWord(String(c.id))}` : c.kind === 'cng' ? `run: certutil -user -csp "Microsoft Software Key Storage Provider" -delkey ${JSON.stringify(String(c.id))}` : `open Keychain Access and delete the private key ${JSON.stringify(String(c.id ?? 'trocar'))} from your login keychain`
    return `${how} (the private key of the trocar root with SHA-256 ${e.fp256 ?? 'unknown'}; remove the root from your trust store first)`
  }
  if (e.kind === 'json-array-item') return `edit ${where}: remove ${JSON.stringify(e.item)} from the list ${(e.keys || []).join('.')}${e.created_array ? ', then delete the list if it is now empty (trocar created it)' : ''}`
  if (e.kind === 'run-key') {
    const at = `${e.hive ?? RUN_KEY.hive}\\${e.key ?? RUN_KEY.key}\\${e.name ?? RUN_KEY.name}`
    return e.prior ? `run: reg add ${at} /t ${e.prior.kind} /d ${JSON.stringify(e.prior.value)} /f (put your own value back, the one trocar recorded)` : `run: reg delete ${at} /f`
  }
  if (e.kind === 'scheduled-task') return `run: schtasks /Change /TN ${TASK_NAME} /DISABLE (an uninstall deletes it: schtasks /Delete /TN ${TASK_NAME} /F)`
  if (e.kind === 'forwarder-binary') return `rm ${shellWord(where)} (a kernel still draining holds it: it goes when the drain ends; stop it with trocar off --now)`
  if (typeof e.undo_by_hand === 'string' && e.undo_by_hand) return e.undo_by_hand
  if (KNOWN_KINDS.includes(e.kind)) return `${where}: change trocar made for the old capture (${e.kind}); undo it with "trocar off"`
  return `${where}: this item is of kind ${JSON.stringify(e.kind ?? null)}, which this build does not know; use the trocar that wrote it ("trocar off"), or look at ${where} and the manifest's entry for it`
}

/** The command that puts a file back as it was before trocar, from the backup of it (R2), and what it costs; null when there is no backup (trocar made the file). Plain `cp`: an
 *  existing file keeps its own mode and owner, and the user chooses to run it — trocar never writes a backup over a user's file by itself (1.6 R2). */
export function restoreByHand(e) {
  if (!e || typeof e.backup !== 'string' || e.backup === '') return null
  return { backup: e.backup, command: `cp ${shellWord(e.backup)} ${shellWord(e.real_path || e.path)}`, loses: 'puts the whole file back as it was before trocar, so every change made to it since is lost' }
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
    if (e.kind == null) e.kind = e.format ? 'text' : 'json-key' // a writer that pushed an entry without its kind (saveManifestAt fills it)
    if (e.backup === undefined) e.backup = null
    if (e.scope === undefined) e.scope = 'agent' // 1.6 §1.7: what the item reaches — a manifest of before the field reads every item as 'agent'
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

const unsupportedVersion = (v) => v !== MANIFEST_VERSION
/** The tools that undo a manifest of version 1 or 2, in the order a refusal names them (4.11 ⑰): the trocar from main before the collector model, then the standalone copy. */
const V2_TOOLS = Object.freeze(['main-before-model', 'standalone'])

// What a manifest of the version this build reads must look like before anything uses it: the lists it names are lists of the right items. A file that parses as JSON but
// has another shape (`entries: {}`, `entries: [null]`, `files: null`) is not the manifest trocar wrote — it is as unusable as one that does not parse, and the callers treat it
// the same way (an error to say, then trocar's own marks), instead of crashing half-way through an undo with the routing already off (R3, R11). `entries` and `files` are
// always written (newManifest), so a missing one is damage.
function checkShape(m, name) {
  const need = (key, item, required) => {
    if (m[key] === undefined && !required) { m[key] = []; return }
    if (!Array.isArray(m[key])) throw new Error(`${name} is not an install manifest this build can use: \`${key}\` is ${m[key] === undefined ? 'missing' : `not a list (${m[key] === null ? 'null' : typeof m[key]})`}`)
    const bad = m[key].findIndex((x) => (item === 'object' ? !isPlainObject(x) : typeof x !== 'string'))
    if (bad >= 0) throw new Error(`${name} is not an install manifest this build can use: \`${key}[${bad}]\` is not ${item === 'object' ? 'an object' : 'a string'}`)
  }
  if (m.entries === undefined && m.files === undefined) throw new Error(`${name} is not an install manifest this build can use: it lists neither \`entries\` nor \`files\``)
  need('entries', 'object', true)
  need('files', 'object', true)
  need('watched', 'object', false)
  need('dirs', 'string', false)
}

/** Text → manifest. A version 1 or 2 text (written before the collector model) is not read at all: `{ unsupported: 'v2', version, tools }` — nothing in this
 *  build migrates or undoes it (4.11 ⑰; refuseOldManifest says what does). A version above 3 comes back as parsed, flagged `unsupported: true`, untouched.
 *  Throws what JSON.parse throws, or an Error for JSON that is not an object or whose lists are not the lists of a manifest. */
export function parseManifest(text, name = MANIFEST) {
  const m = JSON.parse(text)
  if (!isPlainObject(m)) throw new Error(`${name} is not a manifest (a JSON object)`)
  const v = m.version === undefined ? 1 : m.version
  if (Number.isInteger(v) && v >= 1 && v < MANIFEST_VERSION) return { unsupported: 'v2', version: v, tools: [...V2_TOOLS] }
  if (unsupportedVersion(v)) return { ...m, unsupported: true }
  checkShape(m, name)
  return completeManifest(m)
}

/** Every command that can write (on, off, uninstall, the standalone trocar-off, install) asks this BEFORE ANY write (4.11 ⑰, CM29): null, or — for a manifest
 *  of version 1 or 2 — `{ version, message }`, the command then exits 1 having written nothing (not even ~/.trocar/bin/trocar-off). The
 *  message names the tools that undo it, in order: the trocar from main before the collector model, then the standalone copy (`node "<path>"` on Windows). A manifest that cannot be read is not this refusal's: null, and the command's own read says it. */
export function refuseOldManifest({ home = nodeOs.homedir(), platform = process.platform, fs = nodeFs } = {}) {
  let m
  try { m = readManifest(collectorDir(home), fs) } catch { return null }
  if (!m || m.unsupported !== 'v2') return null
  const copy = standalonePath(home)
  const message = [
    `the install manifest ${manifestPath(collectorDir(home))} is version ${m.version}, written by an trocar from before the collector model; this trocar does not read it and changed nothing. Undo it first with the trocar that wrote it:`,
    '  1. the trocar from main before the collector model (PR-1): trocar off, then trocar uninstall',
    `  2. without that build, the standalone copy it left: ${platform === 'win32' ? `node "${copy}"` : shellWord(copy)}`,
    'then run trocar install.',
  ].join('\n')
  return { version: m.version, message }
}

/** The manifest in the file `file` (the install manifest, or the old capture's ledger ~/.trocar/legacy-manifest.json: the same format), or null when there is none. Never writes. */
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
  if (m.unsupported || unsupportedVersion(m.version)) throw new Error(`the manifest ${file} is version ${JSON.stringify(m.version)}; this build reads version ${MANIFEST_VERSION} only and will not write over it (use the trocar that wrote it)`)
  completeManifest(m)
  for (const it of [...m.entries, ...m.files]) {
    if (!PHASES.includes(it && it.phase)) throw new Error(`the manifest ${file} was not saved: the item ${JSON.stringify((it && it.path) ?? null)} (${it && it.kind}) has no phase (${PHASES.join(' | ')}); every writer says which command wrote it (D55)`)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeDurable(file, JSON.stringify(m, null, 2) + '\n', 0o600, fs)
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
