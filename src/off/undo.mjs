// undo.mjs (src/off) — take asight's trust entries back out, for all harnesses or some, by the 4.6 undo order (RFC 4.6 §安装清单与卸载「撤销顺序」
// 第 1–5 步 and「按 harness 撤」, 1.6 §1.5 / R2 / R3, D28, D39). This is `asight off`'s file work and `asight uninstall`'s (install.mjs calls it for
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
// Liveness is judged from the manifest alone — `manifest.liveness.<harness>` (signature, rereads, until, until_environ) and the `installed_at` of
// the harness's items — plus the process table `procs()` reads, never from the daemon (stopped by now) or the entries (undone by now), so `asight
// off` and `asight-off` give the same answer (1.6 R3). A process table that cannot be read is not "nobody is alive": what depends on it is kept and
// reported unjudged.
//
// `ids` null = every harness; otherwise only those harnesses' entries, bundle, extra files, plugin / shim / rc lines — never the CA (unless
// `dropCa`), never an item of another harness (byte for byte), never a file with no harness. An undone entry leaves manifest.entries; backups: dropped
// when the file is back at its pre_sha256, kept and listed in manifest.kept_backups when the user changed the file after asight did (1.6 R2).
// Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { undoEntry, removeOwnedFile, describeEntry } from './journal.mjs'
import { saveManifest, KNOWN_KINDS, undoByHand, restoreByHand } from './manifest.mjs'
import { dropBackup } from './backup.mjs'
import { backupDir } from './paths.mjs'
import { removeEmptyDirs, sweepTemps, writeDurable, sha256 } from './fsutil.mjs'
import { matchHarness } from './signature.mjs'
import { certBlocks, stripCert, composeBundle, certsOf } from './pem.mjs'

const UNDO_LEFT = new Set(['left-unparsable', 'left-link', 'left-text', 'error']) // an entry that could not be undone stays in the manifest
const UNDO_AT_PRE = new Set(['restored', 'already-restored']) // the file is at its pre_sha256: its backup goes
const KEPT_BECAUSE = {
  'reverted-not-identical': (e) => `${e.path} was edited after asight changed it: only asight's ${describeEntry(e)} was taken out, so it is not what it was before; the backup is that file as it was`,
  missing: (e) => `${e.path} is gone (removed after asight changed it); the backup is what it held before`,
  'left-user-value': (e) => `${e.path} now holds a value the user set in place of asight's, left as it is; the backup is the file as it was before`,
  'already-removed': (e) => `asight's text was no longer in ${e.path}, which is not what it was before; the backup is the file as it was before`,
}
const UNTIL_VALUES = ['restart', 'next-connection', 'next-handshake', 'session-end']

const known = (item) => KNOWN_KINDS.includes(item.kind)
const isMap = (v) => v instanceof Map
const processEnv = (p) => { try { const e = typeof p.env === 'function' ? p.env() : p.env; return isMap(e) ? e : null } catch { return null } } // gone, or not ours to read
const errText = (e) => String((e && e.code) || (e && e.message) || e)
const without = (list, item) => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) }

// May a live process of a harness have read asight's entry for it? It started after the harness's first install time (its entries and the files
// asight owns for it), or the harness re-reads its entry while running (alive is enough), or its start time / the install time is unknown.
const mayHaveRead = (p, l, since) => !!(l && l.rereads) || p.startedAt == null || since == null || p.startedAt >= since

/** Undoes the entries (see the header) → `{ results, kept_bundles, removed, still_trusting, left, residue, changed, procs_error, manifest }`. An error that stops it
 *  part-way (the last write of the manifest: ENOSPC, EACCES, a failed rename) is thrown with `partial` on it: the same object, as far as it got — the files that were
 *  changed or removed by then are in it, because a receipt that said "nothing was changed" over a settings.json that was put back would be untrue (1.6 R1, V3). */
export async function undoHarnesses(args) {
  const out = { results: [], kept_bundles: [], removed: [], still_trusting: [], left: [], residue: [], changed: [], procs_error: null, manifest: args.manifest }
  try { return await undoInto(args, out) } catch (e) {
    if (e && typeof e === 'object') e.partial = out
    throw e
  }
}

async function undoInto({ dir, home, manifest, ids = null, procs = async () => [], roots = null, now = new Date(), dropCa = false, fs = nodeFs }, out) {
  if (manifest.unsupported) throw new Error(`the install manifest is version ${JSON.stringify(manifest.version)}, which this build does not read; nothing was changed`)
  const inScope = (h) => typeof h === 'string' && (ids == null || ids.includes(h))
  const liveness = manifest.liveness && typeof manifest.liveness === 'object' ? manifest.liveness : (manifest.liveness = {})
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
  // an entry that could not be undone: why, and — when asight kept a copy of the file as it was — the one command that puts it back and what that costs (R2:
  // "给出备份路径、手动 cp 命令和会丢掉什么"); the receipt prints `reason`, `--json` also carries `backup` and `restore`
  const leftRow = (e, why, result) => {
    const back = restoreByHand(e)
    return { path: e.path, harness: e.harness, result, reason: back ? `${why}. The file as it was before asight is kept at ${back.backup}; by hand: ${back.command} (${back.loses})` : why, ...(back ? { backup: back.backup, restore: back.command } : {}) }
  }

  // ── 1 and 4: entries ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const undoOne = (e) => {
    let r
    try { r = undoEntry(e, { fs }) } catch (err) { r = { path: e.path, harness: e.harness, result: 'error', reason: String((err && err.message) || err) } }
    const row = { ...r, backup: e.backup ?? null, what: describeEntry(e) } // `what`: what asight put there (the key and value, the block, the line), for a message
    out.results.push(row)
    if (UNDO_LEFT.has(r.result)) { // stays in the manifest, with its backup: the only copy of what the user had
      leftEntries.push(e)
      out.left.push(leftRow(e, r.result === 'left-unparsable' ? `${e.path} is no longer valid JSON; asight's ${describeEntry(e)} may still be in it` : r.reason, r.result))
      if (e.backup) row.backup_kept = e.backup
      return
    }
    without(manifest.entries, e)
    if (!e.backup) return
    const keep = (reason) => { manifest.kept_backups.push({ path: e.path, backup: e.backup, reason, at: now.toISOString() }); row.backup_kept = e.backup }
    if (!UNDO_AT_PRE.has(r.result)) return keep((KEPT_BECAUSE[r.result] || (() => `${e.path}: ${r.result}`))(e))
    try { dropBackup(e.backup, fs) } catch (err) { row.backup_error = errText(err); keep(`${e.backup}, the backup of ${e.path}, could not be removed (${errText(err)}); remove it by hand`) }
  }
  const entries = [...manifest.entries].reverse().filter((e) => inScope(e.harness) && (e.kind === 'json-key' || e.kind === 'text'))
  const config = (e) => !(e.kind === 'text' && e.format !== 'dotenv-block') // step 1; the rest are step 4's
  const originals = entries.filter(config) // step 1's, as they are now: undoing takes them out of the manifest, and a bundle is judged after that
  for (const e of entries) if (config(e)) undoOne(e)
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
    // An environment that cannot be read is not an empty one (proc.mjs): for an extra file, which only an environment names, a process whose environ is
    // unreadable and that is a live process of the harness or descends from one (so it may have inherited the path) is "not known". Not every unreadable
    // one: the capability helper and gpg-agent are non-dumpable on every machine, and nothing of the harness's.
    const unknownEnv = (harness) => {
      const byPid = new Map(t.list.map((p) => [p.pid, p])), from = since.get(harness)
      return t.list.filter((p) => {
        if (processEnv(p) || (p.startedAt != null && from != null && p.startedAt < from)) return false // readable, or older than the file: it cannot hold it
        for (let a = p, seen = new Set(); a && !seen.has(a.pid) && seen.size < 64; a = byPid.get(a.ppid)) { seen.add(a.pid); if (matchHarness(liveness, a) === harness) return true }
        return false
      }).map((p) => p.pid)
    }
    // who may hold this file: a process of its harness that may have read the entry (bundles only — an extra file is named by an environment
    // variable, never by an entry that re-reads), or any whose environ names it (a child that inherited it). `why`: cannot be told.
    const holders = (f, byHarness) => {
      if (t.error) return { why: t.error }
      if (byHarness && !liveness[f.harness]) return { why: `the install manifest has no liveness record for ${f.harness} (written by an older asight; "asight on" adds it, then run this again)` }
      const pids = t.list.filter((p) => {
        const env = processEnv(p)
        return (byHarness && matchHarness(liveness, p) === f.harness && mayHaveRead(p, liveness[f.harness], since.get(f.harness))) || (!!env && [...env.values()].some((v) => typeof v === 'string' && v.includes(f.path)))
      }).map((p) => p.pid)
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
    const rebuild = (f, keep) => { // gone while a live process may use it: an agent whose entry named it has no network without it (4.6 撤销顺序 第 2 步)
      try {
        if (!roots) throw new Error('no trusted roots were given to rebuild it from')
        const userCerts = [], unread = []
        for (const src of f.sources || []) { try { userCerts.push(...certsOf(src, fs.readFileSync(src)).certs) } catch (e) { unread.push({ file: src, errno: errText(e) }) } } // moved or gone: not carried over, and said
        const c = composeBundle({ nodeRoots: roots.node, osRootsText: roots.osText, userCerts, caPem: null })
        fs.mkdirSync(path.dirname(f.path), { recursive: true, mode: 0o700 })
        writeDurable(f.path, c.data, 0o600, fs)
        const lost = (f.user_fps || []).filter((x) => !c.user_fps.includes(x))
        Object.assign(f, { roots_fp: c.roots_fp, sha256: sha256(Buffer.from(c.data)), user_fps: c.user_fps, without_ca: true })
        out.kept_bundles.push({ ...keep, rebuilt: true, ...(lost.length ? { lost_fps: lost, unread } : {}) })
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
    const one = (f, byHarness) => {
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
      else if (h.pids || entry.length) rebuild(f, keep)
      else { out.kept_bundles.push(keep); fail(f, `${f.path} is gone, and whether a running process uses it is not known (${h.why}), so it was not rebuilt`) }
    }
    for (const f of bundles) one(f, true)
    for (const f of extras) one(f, false)
  }
  if (dropCa) for (const f of manifest.files.filter((x) => x.role === 'ca-cert' && known(x))) { try { rm(f.path); without(manifest.files, f) } catch (e) { fail(f, `${f.path} could not be removed (${errText(e)})`) } } // uninstall only (4.6 第 3 步)

  // ── 4: rc lines and patch rows, then plugins and the shim ─────────────────────────────────────────────────────────────────────────
  for (const e of entries) if (!config(e)) undoOne(e)
  removeEmptyDirs([backupDir(home)], fs) // the last backup is gone (rmdir leaves a directory that still holds one)
  for (const f of [...manifest.files].reverse().filter((x) => (x.role === 'plugin' || x.role === 'shim') && inScope(x.harness) && known(x))) {
    try {
      const r = removeOwnedFile(f, fs)
      if (r.result === 'removed') out.removed.push(f.path)
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
    for (const p of t.list) {
      const h = matchHarness(liveness, p)
      const l = h && touched.has(h) ? liveness[h] : null
      if (!l || !mayHaveRead(p, l, since.get(h))) continue
      if (l.until_environ) { const v = (processEnv(p) || new Map()).get(l.until_environ); if (!(typeof v === 'string' && v.startsWith(dir + path.sep))) continue } // it never read asight's file
      out.still_trusting.push({ pid: p.pid, harness: h, until: UNTIL_VALUES.includes(l.until) ? l.until : 'restart' })
    }
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
