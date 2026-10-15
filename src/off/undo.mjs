// undo.mjs (src/off) — take asight's trust entries back out, for all harnesses or some, by the 4.6 undo order (RFC 4.6 §安装清单与卸载「撤销顺序」
// 第 1–5 步 and「按 harness 撤」, 1.6 §1.5 / R2 / R3, D39). This is `asight off`'s file work and `asight uninstall`'s (install.mjs calls it for
// every harness); the standalone ~/.asight/bin/asight-off is made of src/off alone, so it needs nothing outside this directory (0.1 §2).
//
//   1  the config entries (JSON keys, dotenv blocks), each by the rule for one file (journal.mjs undoEntry): back byte for byte when untouched,
//      else only asight's key / block / line goes and the user's commented line comes back
//   2  each combined bundle `combined-<h>.pem`: nobody holds it → removed; a live process may have loaded it → kept, the same file without the
//      asight CA, its pids reported (judged again by the next run); gone while a live process may use it → rebuilt without the CA from Node's
//      roots, the OS roots and the user CAs the install recorded; unreadable while one may hold it → it still holds the CA: an item left
//   3  the harness's extra trust files (`extra-cc.pem`, `extra-kimi.pem`, role trust-file): the same, but only a process whose environ names the
//      file keeps it; and, only for `uninstall` (`dropCa`), asight-ca.pem — `off` never removes the CA, the next `on` uses it again
//   4  rc lines and patch rows (each loading line before the file it loads), then the plugins and the shim
//   5  the live processes that may still trust asight (reported, never restarted)
// Liveness is judged from the manifest — `manifest.liveness.<harness>` (identity, rereads, until, until_environ), plus the names agents.json holds now — and the `installed_at` of
// the harness's items — plus the process table `procs()` reads, never from the daemon (stopped by now) or the entries (undone by now), so `asight
// off` and `asight-off` give the same answer (1.6 R3). A process table that cannot be read is not "nobody is alive": what depends on it is kept and
// reported unjudged — and so is a harness whose snapshot has no signature (none recorded, or null: the asight that wrote it had none for its OS).
// Where the OS never shows another process's environment (macOS, Windows: the rows say `envRead: false`), a process of the harness, or one it
// started, may hold an extra trust file: it is a holder, not "not known" (4.6 「判活快照」).
//
// `ids` null = every harness; otherwise only those harnesses' entries, bundle, extra files, plugin / shim / rc lines — never the CA (unless
// `dropCa`), never an item of another harness (byte for byte), never a file with no harness. An undone entry leaves manifest.entries; backups: dropped
// when the file is back at its pre_sha256, kept and listed in manifest.kept_backups when the user changed the file after asight did (1.6 R2).
// Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { undoEntry, removeOwnedFile, undoWrapper, describeEntry } from './journal.mjs'
import { saveManifest, KNOWN_KINDS, FILE_ENTRY_KINDS, undoByHand, restoreByHand } from './manifest.mjs'
import { undoRunKey, undoScheduledTask } from './win32.mjs'
import { dropBackup } from './backup.mjs'
import { backupDir, asightHome } from './paths.mjs'
import { removeEmptyDirs, sweepTemps, writeDurable, sha256, strictlyInside } from './fsutil.mjs'
import { harnessesOf, hasIdentity, withAgentList } from './signature.mjs'
import { readAgentList } from './identity.mjs'
import { certBlocks, stripCert, composeBundle, certsOf } from './pem.mjs'
import { offLines } from './text-edit.mjs'
import { decodeText } from './text-codec.mjs'

const UNDO_LEFT = new Set(['left-unparsable', 'left-unreadable', 'left-link', 'left-text', 'error']) // an entry that could not be undone stays in the manifest
const UNDO_AT_PRE = new Set(['restored', 'already-restored']) // the file is at its pre_sha256: its backup goes
const KEPT_BECAUSE = {
  'reverted-not-identical': (e) => `${e.path} was edited after asight changed it: only asight's ${describeEntry(e)} was taken out, so it is not what it was before; the backup is that file as it was`,
  missing: (e) => `${e.path} is gone (removed after asight changed it); the backup is what it held before`,
  'left-user-value': (e) => `${e.path} now holds a value the user set in place of asight's, left as it is; the backup is the file as it was before`,
  'already-removed': (e) => `asight's text was no longer in ${e.path}, which is not what it was before; the backup is the file as it was before`,
}
const UNTIL_VALUES = ['restart', 'next-connection', 'next-handshake', 'session-end']

const known = (item) => KNOWN_KINDS.includes(item.kind)
const REMOVED_ROLES = ['plugin', 'shim', 'switch', 'config-entry'] // step 4's owned files: removed whatever their content (a changed one is said)
const isMap = (v) => v instanceof Map
const processEnv = (p) => { try { const e = typeof p.env === 'function' ? p.env() : p.env; return isMap(e) ? e : null } catch { return null } } // gone, or not ours to read
const errText = (e) => String((e && e.code) || (e && e.message) || e)
const without = (list, item) => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) }

// May a live process of a harness have read asight's entry for it? It started after the harness's first install time (its entries and the files
// asight owns for it), or the harness re-reads its entry while running (alive is enough), or its start time / the install time is unknown.
const mayHaveRead = (p, l, since) => !!(l && l.rereads) || p.startedAt == null || since == null || p.startedAt >= since
// A harness whose snapshot has no signature (no record: an older asight; null: none for its OS) cannot tell its processes from the others, so any live
// process that may have read its entry may be one of them (a record that is missing says nothing of re-reading either: alive is enough). → their pids;
// none means nobody can hold what asight wrote for it, signature or not (4.6 「判活快照」).
const unsignedOf = (liveness, list, h, since) => (hasIdentity(liveness[h]) ? [] : list.filter((p) => mayHaveRead(p, liveness[h] || { rereads: true }, since)).map((p) => p.pid))
// why such a harness cannot be judged, said the same way for its files (step 2 / 3) and for who still trusts asight (step 5)
const unsignedWhy = (liveness, h) => (liveness[h]
  ? `the install manifest has no process identity for ${h} (the asight that wrote it had none for this OS; "asight on" records it, then run this again)`
  : `the install manifest has no liveness record for ${h} (written by an older asight; "asight on" adds it, then run this again)`)

/** Undoes the entries (see the header) → `{ results, kept_bundles, removed, still_trusting, trust_unknown, left, residue, changed, procs_error, manifest }` (`trust_unknown`:
 *  `[{ harness, why }]`, the harnesses step 5 cannot judge, their snapshot having no signature). An error that stops it
 *  part-way (the last write of the manifest: ENOSPC, EACCES, a failed rename) is thrown with `partial` on it: the same object, as far as it got — the files that were
 *  changed or removed by then are in it, because a receipt that said "nothing was changed" over a settings.json that was put back would be untrue (1.6 R1, V3). */
export async function undoHarnesses(args) {
  const out = { results: [], kept_bundles: [], removed: [], still_trusting: [], trust_unknown: [], left: [], residue: [], changed: [], notes: [], procs_error: null, manifest: args.manifest }
  try { return await undoInto(args, out) } catch (e) {
    if (e && typeof e === 'object') e.partial = out
    throw e
  }
}

/** `uninstall`'s kernel removal (4.8 §8): the exe, `LICENSE-mihomo.txt` and `SOURCE-mihomo.txt` beside it, the kernel directory, and the
 * verified-archive cache (`kernel-archive/`) — the whole thing asight's `on` placed or downloaded. A file the system still holds (the kernel is running, a
 * drain is on) stays and the reason says so: asight does not stop it by itself (W28, the entries-kind branch's rule from day one). */
const removeKernelCopy = (exe, fs) => {
  const dir = path.dirname(exe)
  try {
    fs.rmSync(exe, { force: true })
    for (const name of ['LICENSE-mihomo.txt', 'SOURCE-mihomo.txt']) { try { fs.rmSync(path.join(dir, name), { force: true }) } catch { /* the exe is gone: a stray text file is not a lock */ } }
    try { fs.rmdirSync(dir) } catch { /* not empty, or gone */ }
    try { fs.rmSync(path.join(path.dirname(dir), 'kernel-archive'), { recursive: true, force: true }) } catch (e) { return { ok: false, reason: `${exe} was removed, but the verified-archive cache beside it could not be (${errText(e)}); remove it by hand` } }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `${exe} could not be removed (${errText(e)}); a kernel still running holds it — stop it (asight off --now), then run this again` }
  }
}

async function undoInto({ dir, home, manifest, ids = null, procs = async () => [], roots = null, now = new Date(), dropCa = false, custody = null, fs = nodeFs, exec = null, env = process.env }, out) {
  if (manifest.unsupported) throw new Error(`the install manifest is version ${JSON.stringify(manifest.version)}, which this build does not read; nothing was changed`)
  const inScope = (h) => typeof h === 'string' && (ids == null || ids.includes(h))
  const liveness = manifest.liveness && typeof manifest.liveness === 'object' ? manifest.liveness : (manifest.liveness = {})
  // judged by the manifest's records plus the names the user's agents.json holds NOW (one put there after `on` is a process of that harness too);
  // a list that cannot be read only adds nothing, and is said. `liveness` itself (what is saved) is not changed by it
  const { liveness: judged, note: listNote } = withAgentList(liveness, home ? readAgentList({ home, fs }) : null)
  if (listNote && Object.keys(liveness).length) out.notes.push(listNote)
  if (!Array.isArray(manifest.kept_backups)) manifest.kept_backups = []

  // what the judgement needs, taken before any entry leaves the manifest
  const since = new Map()
  for (const it of [...manifest.entries, ...manifest.files]) {
    const t = Date.parse(it.installed_at)
    if (inScope(it.harness) && Number.isFinite(t)) since.set(it.harness, Math.min(since.get(it.harness) ?? Infinity, t))
  }
  const touched = new Set([...manifest.entries, ...manifest.files].map((x) => x.harness).filter(inScope))
  const table = async () => { try { return { list: await procs(), error: null } } catch (e) { return { list: [], error: errText(e) } } }
  const leftEntries = [] // the entries step 1 could not undo: they stay in the manifest and still name what they named
  const rm = (p) => { sweepTemps(p, fs); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); out.removed.push(p) } }
  const fail = (item, reason) => { out.left.push({ path: item.path, harness: item.harness ?? null, result: 'error', reason }) }
  // What is removed, rewritten or rebuilt at a path the manifest names is inside ~/.asight, where asight puts its bundles, trust files and CA: a manifest that names another
  // path is damaged or was edited, and following it would take the user's files (audit semantics 6). The item stays in the manifest, so the next run says it again.
  const outside = (f) => (strictlyInside(asightHome(home), f.path, fs) ? null : `${f.path} is not inside ${asightHome(home)}, so it is not asight's to remove or rewrite (the install manifest names a file asight does not make there: it is damaged or was edited); it is left as it is — correct that item in ${path.join(dir, 'install-manifest.json')} by hand, then run it again`)
  // an entry that could not be undone: why, and — when asight kept a copy of the file as it was — the one command that puts it back and what that costs (R2:
  // "给出备份路径、手动 cp 命令和会丢掉什么"); the receipt prints `reason`, `--json` also carries `backup` and `restore`
  const leftRow = (e, why, result) => {
    const back = restoreByHand(e)
    return { path: e.path, harness: e.harness, result, reason: back ? `${why}. The file as it was before asight is kept at ${back.backup}; by hand: ${back.command} (${back.loses})` : why, ...(back ? { backup: back.backup, restore: back.command } : {}) }
  }

  // ── 1 and 4: entries ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // A file entry (json-key, text, proxy-entry, trust-entry) goes by the file rule; the Windows collector's tool entries by their own verbs
  // (src/off/win32.mjs — the same questions the arch module asks, held equal by test). The kernel's copy is a file asight owns with a rule
  // of its own: `off` keeps it while it drains (removing it would cut agents mid-connection; a later run takes it when the drain is over),
  // `uninstall` removes it, and a Windows that holds it (EBUSY / EPERM: it is running) is reported, not papered over (4.8 §4.2).
  const undoWinItem = (e) => {
    if (FILE_ENTRY_KINDS.includes(e.kind)) return undoEntry(e, { fs })
    if (e.kind === 'run-key') {
      const r = undoRunKey({ prior: e.prior ?? null, run: exec, env })
      return { path: `${e.hive ?? 'HKCU'}\\${e.key ?? ''}\\${e.name ?? ''}`, harness: e.harness, result: r.ok ? (r.result === 'absent' ? 'already-restored' : 'restored') : 'error', ...(r.result === 'left' ? { result: 'left-user-value' } : {}), ...(r.ok ? {} : { reason: r.reason }) }
    }
    if (e.kind === 'scheduled-task') {
      const r = undoScheduledTask({ uninstall: dropCa, prior: e.prior ?? null, run: exec, env })
      return { path: e.path ?? '\\asight\\collector', harness: e.harness, result: r.ok ? (r.task === 'absent' ? 'already-restored' : 'restored') : 'error', ...(r.ok ? {} : { reason: [r.reason, r.runKeyReason].filter(Boolean).join('; ') }) }
    }
    if (e.kind === 'forwarder-binary') { // uninstall only (the entries filter keeps it out of an `off`)
      const file = e.path || e.real_path
      const r = removeKernelCopy(file, fs)
      return { path: file, harness: e.harness, result: r.ok ? 'restored' : 'error', ...(r.ok ? {} : { reason: r.reason }) }
    }
    return { path: e.path, harness: e.harness, result: 'error', reason: `${e.path} is of kind ${JSON.stringify(e.kind)}, which this build does not undo` }
  }
  const undoOne = (e) => {
    let r
    try { r = undoWinItem(e) } catch (err) { r = { path: e.path, harness: e.harness, result: 'error', reason: String((err && err.message) || err) } }
    const row = { ...r, backup: e.backup ?? null, what: describeEntry(e) } // `what`: what asight put there (the key and value, the block, the line), for a message
    out.results.push(row)
    if (UNDO_LEFT.has(r.result)) { // stays in the manifest, with its backup: the only copy of what the user had
      leftEntries.push(e)
      out.left.push(leftRow(e, r.reason || `${e.path}: asight cannot read it; asight's ${describeEntry(e)} may still be in it`, r.result))
      if (e.backup) row.backup_kept = e.backup
      return
    }
    without(manifest.entries, e)
    if (!e.backup) return
    const keep = (reason) => { manifest.kept_backups.push({ path: e.path, backup: e.backup, reason, at: now.toISOString() }); row.backup_kept = e.backup }
    if (!UNDO_AT_PRE.has(r.result)) return keep((KEPT_BECAUSE[r.result] || (() => `${e.path}: ${r.result}`))(e))
    try { dropBackup(e.backup, fs) } catch (err) { row.backup_error = errText(err); keep(`${e.backup}, the backup of ${e.path}, could not be removed (${errText(err)}); remove it by hand`) }
  }
  const kernelCopies = manifest.entries.filter((e) => inScope(e.harness) && e.kind === 'forwarder-binary')
  if (!dropCa && kernelCopies.length) out.notes.push(`the kernel's copy (${kernelCopies.map((e) => e.path).join(', ')}) is kept while connections drain from it: it is not undone by \`off\`, \`asight uninstall\` removes it, \`asight off --now\` stops the drain`)
  const entries = [...manifest.entries].reverse().filter((e) => inScope(e.harness) && (FILE_ENTRY_KINDS.includes(e.kind) || e.kind === 'run-key' || e.kind === 'scheduled-task' || (e.kind === 'forwarder-binary' && dropCa)))
  const config = (e) => !((e.kind === 'text' || e.kind === 'trust-entry') && e.format !== 'dotenv-block') // step 1; the rest are step 4's (json-key and proxy-entry are config, a text/trust block is config only as dotenv)
  const originals = entries.filter(config) // step 1's, as they are now: undoing takes them out of the manifest, and a bundle is judged after that
  for (const e of entries) if (config(e)) undoOne(e)
  // D48②: a key the user set while asight was on keeps the user's value, and the old line asight put out of effect stays so (journal.mjs `prior_left`).
  // Its line number is the one in the file as step 1 leaves it: another entry of the same file, undone after it, may have taken lines out above it.
  for (const row of out.results) {
    if (!row.prior_left) continue
    let read = null
    try { read = decodeText(fs.readFileSync(row.real_path || row.path)) } catch { /* gone or unreadable: the numbers stay as the undo found them */ }
    if (read && read.ok && read.text != null) row.prior_left = offLines(read.text, [...new Set(row.prior_left.map((p) => p.key))])
  }
  // an item this build cannot undo is said, here and not by each caller: an entry or a file of an unknown kind (it is not touched, whatever its role),
  // or an entry that names no harness (no harness's `off` takes it). It stays in the manifest and `off` exits 1 for it (1.6 R3). The old capture's
  // ledger kinds are known: the legacy undo takes them.
  for (const e of [...manifest.entries, ...manifest.files]) {
    const orphan = (e.kind === 'json-key' || e.kind === 'text') && typeof e.harness !== 'string'
    if ((known(e) && !orphan) || !(ids == null || (typeof e.harness === 'string' && ids.includes(e.harness)))) continue
    out.left.push({ path: e.path, harness: e.harness ?? null, result: 'unknown-kind', reason: orphan ? `${e.path} names no harness, so no harness's off takes it out; ${undoByHand(e)}` : `${e.path} is of kind ${JSON.stringify(e.kind ?? null)}, which this build does not undo; by hand: ${undoByHand(e)}` })
  }

  // ── 2 and 3: bundles and extra trust files ────────────────────────────────────────────────────────────────────────────────────────
  const bundles = manifest.files.filter((f) => f.role === 'bundle' && inScope(f.harness) && known(f))
  const extras = manifest.files.filter((f) => f.role === 'trust-file' && inScope(f.harness) && known(f))
  if (bundles.length || extras.length) {
    const t = await table()
    const ca = (() => {
      const file = (manifest.files.find((f) => f.role === 'ca-cert') || {}).path || path.join(dir, 'ca', 'asight-ca.pem')
      try { const b = certBlocks(fs.readFileSync(file, 'utf8')); return b.length ? { fp: b[0].fp, error: null } : { fp: null, error: `${file} holds no certificate` } } catch (e) { return { fp: null, error: errText(e) } }
    })()
    const unsigned = (harness) => unsignedOf(judged, t.list, harness, since.get(harness))
    // the live processes `pick` keeps that are of `harness` or descend from one of it (so they may have inherited a path), started after its first install time
    const kin = (harness, pick) => {
      const byPid = new Map(t.list.map((p) => [p.pid, p])), from = since.get(harness)
      return t.list.filter((p) => {
        if (!pick(p) || (p.startedAt != null && from != null && p.startedAt < from)) return false // older than the file: it cannot hold it
        for (let a = p, seen = new Set(); a && !seen.has(a.pid) && seen.size < 64; a = byPid.get(a.ppid)) { seen.add(a.pid); if (harnessesOf(judged, a).includes(harness)) return true }
        return false
      }).map((p) => p.pid)
    }
    // An environment that cannot be read is not an empty one (proc.mjs): for an extra file, which only an environment names, a process whose environ
    // could not be read and that is of the harness or descends from one is "not known". Not every unreadable one: the capability helper and gpg-agent are
    // non-dumpable on every machine, and nothing of the harness's. Where the OS never shows it (`envRead: false`: macOS, Windows) such a process is a holder.
    const unknownEnv = (harness) => kin(harness, (p) => !processEnv(p) && p.envRead !== false)
    const hiddenEnv = (harness) => kin(harness, (p) => p.envRead === false)
    // who may hold this file: a process of its harness that may have read the entry (bundles only — an extra file is named by an environment
    // variable, never by an entry that re-reads), or any whose environ names it (a child that inherited it). `why`: cannot be told.
    const holders = (f, byHarness) => {
      if (t.error) return { why: t.error }
      if (unsigned(f.harness).length) return { why: unsignedWhy(judged, f.harness) }
      const pids = t.list.filter((p) => {
        const env = processEnv(p)
        return (byHarness && harnessesOf(judged, p).includes(f.harness) && mayHaveRead(p, judged[f.harness], since.get(f.harness))) || (!!env && [...env.values()].some((v) => typeof v === 'string' && v.includes(f.path)))
      }).map((p) => p.pid)
      if (!byHarness) pids.push(...hiddenEnv(f.harness).filter((pid) => !pids.includes(pid)))
      const unknown = byHarness || pids.length ? [] : unknownEnv(f.harness)
      return unknown.length ? { why: `the environment of pid ${unknown.join(', ')}, a running ${f.harness} process or one started by it, cannot be read, so whether it holds this file is not known` } : { pids }
    }
    // `f` kept, without the asight CA: stripped in place (atomic). { ok } done (or already so); { holds } it still holds the CA — it cannot be
    // rewritten, or the CA cannot be named; { gone } it cannot be read, with the errno
    const strip = (f) => {
      let cur
      try { cur = fs.readFileSync(f.path, 'utf8') } catch (e) { return { gone: errText(e) } }
      // no CA fingerprint to look for: an uninstall's step 3 already removed asight-ca.pem. A file that is byte for byte what an earlier run
      // wrote without the CA (`without_ca`, and the sha it recorded then) is still so, so the next run judges it by the same rule (4.6 第 2 步)
      if (!ca.fp) return f.without_ca === true && f.sha256 === sha256(Buffer.from(cur)) ? { ok: true } : { holds: ca.error }
      const s = stripCert(cur, ca.fp)
      if (!s.removed) return { ok: true } // already without it (an earlier run kept it so)
      try { writeDurable(f.path, s.text, 0o600, fs); Object.assign(f, { sha256: sha256(Buffer.from(s.text)), without_ca: true }); return { ok: true } } catch (e) { return { holds: errText(e) } }
    }
    // `roots` may be a function: `off` reads this platform's OS roots only for a bundle it rebuilds, once (the darwin read runs `security`, os-roots.mjs).
    // Asked outside rebuild's try: what it throws (only a sandboxed test's ESANDBOX, orchestrate.mjs rebuildRoots) is not a bundle that could not be rebuilt.
    let rootsRead = null
    const rootsNow = () => (typeof roots === 'function' ? (rootsRead || (rootsRead = Promise.resolve(roots()))) : Promise.resolve(roots))
    const rebuild = async (f, keep) => { // gone while a live process may use it: an agent whose entry named it has no network without it (4.6 撤销顺序 第 2 步)
      const roots = await rootsNow()
      try {
        if (!roots) throw new Error('no trusted roots were given to rebuild it from')
        const userCerts = [], unread = []
        for (const src of f.sources || []) { try { userCerts.push(...certsOf(src, fs.readFileSync(src)).certs) } catch (e) { unread.push({ file: src, errno: errText(e) }) } } // moved or gone: not carried over, and said
        const c = composeBundle({ nodeRoots: roots.node, osRootsText: roots.osText, userCerts, caPem: null })
        fs.mkdirSync(path.dirname(f.path), { recursive: true, mode: 0o700 })
        writeDurable(f.path, c.data, 0o600, fs)
        const lost = (f.user_fps || []).filter((x) => !c.user_fps.includes(x))
        Object.assign(f, { roots_fp: c.roots_fp, sha256: sha256(Buffer.from(c.data)), user_fps: c.user_fps, without_ca: true })
        out.kept_bundles.push({ ...keep, rebuilt: true, ...(lost.length ? { lost_fps: lost, unread } : {}), ...(roots.missing ? { os_roots_missing: roots.missing } : {}), ...(roots.partial ? { os_roots_partial: roots.partial } : {}), ...(roots.dropped ? { os_roots_dropped: roots.dropped } : {}) })
      } catch (e) {
        out.kept_bundles.push({ ...keep, error: errText(e) })
        fail(f, `${f.path} is gone and could not be rebuilt (${errText(e)}); ${keep.pids.length ? `a running process may use it (pid ${keep.pids.join(', ')}): restart ${f.harness}` : `${f.harness} reads it at its next start, through ${keep.entry_left.join(', ')} that could not be undone: fix that, then run it again`}`)
      }
    }
    // does an entry step 1 could not undo still name this file? a JSON entry by its value, a dotenv block by one of its variables
    const viaLeft = (f) => leftEntries.filter((e) => e.harness === f.harness && [e.value, ...Object.values(e.vars || {})].some((v) => typeof v === 'string' && path.resolve(v) === path.resolve(f.path))).map((e) => e.path)
    // ...and the file itself is read again, whatever step 1 said of the entry: an entry reported as undone, or as the user's own value, whose file still holds the
    // path (a key the user moved, text in a form the removal did not read) leaves the agent with no network once the bundle goes. Such an entry is put back among
    // the ones left (it stays in the manifest), so the next run looks at it again and this one exits 1.
    const namesFile = (e, p) => { try { return fs.readFileSync(e.path, 'utf8').split('\n').some((l) => !/^\s*#/.test(l) && l.includes(p)) } catch { return false } }
    const naming = (f) => {
      for (const e of originals) {
        if (e.harness !== f.harness || leftEntries.includes(e) || !namesFile(e, f.path)) continue
        leftEntries.push(e)
        if (!manifest.entries.includes(e)) manifest.entries.push(e)
        out.left.push(leftRow(e, `${e.path} still names ${f.path}, the bundle asight made for ${f.harness}, though its entry was reported as undone; asight did not take the bundle away under it: edit the file so it no longer names it`, 'left-text'))
      }
      return viaLeft(f)
    }
    const one = async (f, byHarness) => {
      const away = outside(f)
      if (away) { fail(f, away); return }
      const h = holders(f, byHarness)
      // a replace-semantics bundle the entry of which is still in place is in use by the next start of its agent, whether or not a process holds
      // it now: removing it leaves an agent with no network (4.6 安装 / 卸载不静默); an extra file is only warned about by Node when it is gone
      const entry = byHarness ? naming(f) : []
      if (h.pids && !h.pids.length && !entry.length) { // nobody holds it: removed whatever its state (a directory too)
        try { rm(f.path); without(manifest.files, f) } catch (e) {
          out.kept_bundles.push({ path: f.path, harness: f.harness, pids: [], holds_ca: true, error: errText(e) })
          fail(f, `${f.path} is held by no running process but could not be removed (${errText(e)}); it still holds the asight CA — fix the file, then run it again`)
        }
        return
      }
      const keep = { path: f.path, harness: f.harness, pids: h.pids || [], ...(h.why ? { unjudged: true, error: h.why } : {}), ...(entry.length ? { entry_left: entry } : {}) }
      const s = strip(f)
      const used = [...(keep.pids.length ? [`a running process may have loaded it (pid ${keep.pids.join(', ')})`] : []), ...(entry.length ? [`${entry.join(', ')}, which could not be undone, still points at it`] : [])].join(' and ') || 'a running process may have loaded it (pid unknown)'
      if (s.ok) {
        out.kept_bundles.push(keep)
        if (h.why) fail(f, `${f.path} is kept, without the asight CA, because whether a running process holds it is not known (${h.why}); run it again`)
        else if (entry.length) fail(f, `${f.path} is kept, without the asight CA, because ${used}: fix that entry, then run it again`)
      } else if (s.holds || s.gone !== 'ENOENT') { // unreadable, or unwritable: it still holds the CA
        const why = s.holds || s.gone
        out.kept_bundles.push({ ...keep, holds_ca: true, error: why })
        fail(f, `${f.path} still holds the asight CA: it could not be rewritten without it (${why}), and ${used}; it is kept as it is — fix the file, then run it again`)
      } else if (!byHarness) without(manifest.files, f) // an extra file that is gone only warns where it is named: nothing to keep
      else if (h.pids || entry.length) await rebuild(f, keep)
      else { out.kept_bundles.push(keep); fail(f, `${f.path} is gone, and whether a running process uses it is not known (${h.why}), so it was not rebuilt`) }
    }
    for (const f of bundles) await one(f, true)
    for (const f of extras) await one(f, false)
  }
  if (dropCa) for (const f of manifest.files.filter((x) => x.role === 'ca-cert' && known(x))) { const away = outside(f); if (away) { fail(f, away); continue }; try { rm(f.path); without(manifest.files, f) } catch (e) { fail(f, `${f.path} could not be removed (${errText(e)})`) } } // uninstall only (4.6 第 3 步)

  // ── 4: rc lines and patch rows, then plugins and the shim ─────────────────────────────────────────────────────────────────────────
  for (const e of entries) if (!config(e)) undoOne(e)
  removeEmptyDirs([backupDir(home)], fs) // the last backup is gone (rmdir leaves a directory that still holds one)
  for (const f of [...manifest.files].reverse().filter((x) => (REMOVED_ROLES.includes(x.role) || (x.role === 'wrapper' && dropCa)) && inScope(x.harness) && known(x))) {
    try {
      const r = f.role === 'wrapper' ? undoWrapper(f, fs) : removeOwnedFile(f, fs)
      if (r.result === 'error') { fail(f, r.reason); continue }
      if (r.result === 'removed') out.removed.push(r.path)
      if (r.changed) out.changed.push({ harness: f.harness, path: f.path, role: f.role }) // not what asight wrote: removed all the same, and said
      without(manifest.files, f)
    } catch (err) { fail(f, `${f.path}, asight's ${f.role}, could not be removed: ${String((err && err.message) || err)}`) }
  }
  for (const w of manifest.watched || []) { // what an agent wrote because of asight's file: reported, never deleted
    if (inScope(w.harness) && !w.existed_before && fs.existsSync(w.path)) out.residue.push({ harness: w.harness, path: w.path, why: w.why })
  }

  // ── 5: who may still trust asight (never restarted) ───────────────────────────────────────────────────────────────────────────────
  if (touched.size) {
    const t = await table()
    out.procs_error = t.error
    if (!t.error) out.trust_unknown = [...touched].filter((h) => unsignedOf(judged, t.list, h, since.get(h)).length).map((h) => ({ harness: h, why: unsignedWhy(judged, h) })) // nothing tells its processes apart: not "none of them"
    for (const p of t.list) for (const h of harnessesOf(judged, p)) { // a process two harnesses claim may trust each one's file (D50: one more, never one less)
      const l = touched.has(h) ? judged[h] : null
      if (!l || !mayHaveRead(p, l, since.get(h))) continue
      // it never read asight's file — told by its environment, where the OS shows one (on macOS and Windows a process that may have read it is listed)
      if (l.until_environ && p.envRead !== false) { const v = (processEnv(p) || new Map()).get(l.until_environ); if (!(typeof v === 'string' && v.startsWith(dir + path.sep))) continue }
      out.still_trusting.push({ pid: p.pid, harness: h, until: UNTIL_VALUES.includes(l.until) ? l.until : 'restart' })
    }
  }

  // ── last: the root's private key (4.11 P13 `root-key`), by `uninstall` only, through the custody backend handed in; `off` never touches an install item
  for (const k of manifest.entries.filter((e) => e.kind === 'root-key' && ids == null)) {
    const where = k.path ?? `${(k.custody && k.custody.kind) || 'custody'}:${(k.custody && k.custody.id) || '?'}`
    if (!dropCa) { out.notes.push(`${where}: the asight root's private key stays — off never touches what install wrote; asight uninstall removes it`); continue }
    try {
      if (!custody || typeof custody.remove !== 'function') throw new Error('this asight has no custody backend to remove it with')
      await custody.remove(k.custody)
      without(manifest.entries, k); out.removed.push(where)
    } catch (e) { fail({ ...k, path: where }, `${where}, the asight root's private key, could not be removed (${errText(e)}); by hand: ${undoByHand(k)}`) }
  }

  // a harness with nothing left in the manifest needs no liveness and no watched path any more
  for (const h of touched) {
    if (manifest.entries.some((x) => x.harness === h) || manifest.files.some((x) => x.harness === h)) continue
    delete liveness[h]
    if (Array.isArray(manifest.watched)) manifest.watched = manifest.watched.filter((w) => w.harness !== h)
  }
  saveManifest(dir, manifest, fs)
  return out
}
