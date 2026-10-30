// doctor.mjs — `trocar doctor [<harness>...] [--json]` (RFC 1.6 §2, R4, R11; 4.1 §凭据处置): the self-check an operator runs when something looks wrong. It answers the four questions
// of the 「测试」(is it capturing · is what it captured right · no credential outside the files · no machine-wide TLS weakening) and ④b (every file that holds captured bytes is owner-only), and it
// folds in what `trocar verify` was (the old CA is in the user trust store only). Then it prints, read-only, what `status` knows (the daemon, every harness, the topology) and what the last
// install noted, the standalone undo copy, and the backups no manifest names. It never changes a thing of the user's and starts nothing: its OS queries are read-only (`ps`, the trust-store
// lookup, the process table); the files it may write are `status`'s ~/.trocar/netenv.json (the topology) and, when a sealed capture file could only be read in part, one line in ~/.trocar/raw/journal.jsonl.
//
// Exit (R4): 1 — a capture file others can read (「采集文件可被他人读取」: the bytes hold live API keys) · 3 — it could not judge: no records examined, no file's permissions examined, a file whose permissions
// could not be read, a capture file only partly read — never 0 (reading nothing and answering 「过」 is what this command once did, 0.1 §3) · 0 — the rest. The status block is a report and
// does not change the exit (review B-7). Everything the world gives is a `deps` entry a test replaces (0.1 §3): `has(bin)` (dependency probe), `verify()` (the trust-store check), and the
// ones `runStatusCli` takes (`request`, `procs`, `lingerRead`, …). With none, `has` looks at PATH, `verify` asks the user trust store of THIS home, everything else is real.
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { EXIT, newReceipt } from '../off/schema.mjs' // as in status.mjs: the keys and the exit codes, not ./schema.mjs's checker (D62)
import { unknown } from './text.mjs'
import { resolveHarnesses } from '../off/harness-names.mjs'
import { statusFacts, statusDocOf } from './status.mjs'
import { diagnose, renderFindings } from '../netenv/findings.mjs'
import { serveSource } from '../paths.mjs'
import { formatInstallNotes } from './status-text.mjs'
import { trocarHome, backupDir, collectorDir, standaloneCommand } from '../off/paths.mjs'
import { readManifest, manifestPath } from '../off/manifest.mjs'
import { memoProcQuestions, daemonProcReader } from '../off/proc.mjs'

const USAGE = 'usage: trocar doctor [<harness>...] [--json]'
const LIMIT = 5000 // records sampled (the head of the capture)
const rethrowSandbox = (e) => { if (e && e.code === 'ESANDBOX') throw e } // a refusal of the test guard is never "the tool failed" (0.1 §3)
const errText = (e) => String((e && (e.code || e.message)) || e)
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`) // a path with a space or a quote stays one argument of the chmod line
const indent = (s) => String(s).split('\n').map((l) => `  ${l}`).join('\n')

/** Is `bin` an executable on PATH? Looked up in the files (no `which`: no process to start), `PATHEXT` on Windows. */
export function onPath(bin, { env = process.env, platform = process.platform, fs = nodeFs } = {}) {
  const exts = platform === 'win32' ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : ['']
  for (const dir of String(env.PATH || '').split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, bin + ext), platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return true } catch { /* the next place */ }
    }
  }
  return false
}

/** The regular files directly in `dir` (the backups: trocar made them 0600 in a 0700 directory). A directory that is not there is no files; one that cannot be listed is `error`. */
function filesIn(dir, fs) {
  try { return { files: fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(dir, e.name)) } } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? { files: [] } : { files: [], error: `${dir}: ${errText(e)}` }
  }
}

/** The capture files, sampled records and everything ④b has to look at → { sources, files, extra, records, srcMeta, readErrors }. One resolver for the source, shared with the board (listSources,
 *  src/raw/discover.mjs): a root is usually a DIRECTORY and `serveSource()` returns a list of them (D27) — the day `fs.statSync(list)` threw, the catch swallowed it and doctor
 *  certified a capture it had read nothing from. The resolver itself, never server.mjs: a self-check that dies on a package it does not need says nothing at all — on a tree
 *  without node_modules (a test machine's) `trocar doctor` printed only ERR_MODULE_NOT_FOUND (tested 2026-10-14). */
async function collect({ home, env, sourceFlags, deps, capture }) {
  const { listSources, readRecords, sealedReadProblem } = await capture
  const fs = deps.fs || nodeFs, ah = trocarHome(home)
  const flagged = sourceFlags.filter(Boolean)
  const sources = [].concat(flagged.length ? flagged : env.TROCAR_SOURCE || serveSource({ home: ah, collector: collectorDir(home) })).filter(Boolean)
  const files = [], extra = [], records = [], readErrors = []
  for (const root of sources) {
    try {
      const part = listSources([root])
      files.push(...part.files)
      extra.push(...part.superseded.map((x) => x.sealed)) // sealed copies superseded by an original that still exists hold the same credentials (D35)
    } catch (e) { readErrors.push(`${root}: ${(e && e.message) || e}`) }
  }
  const backups = filesIn(backupDir(home), fs) // what trocar saved of the user's files before changing them: settings with tokens in them (R2)
  if (backups.error) readErrors.push(backups.error)
  extra.push(...backups.files)
  let srcMeta = { exists: false, bytes: 0 }
  if (files.length) {
    let bytes = 0
    for (const f of files) { try { bytes += fs.statSync(f).size } catch { /* counted as unreadable below, when it is read */ } }
    srcMeta = { exists: true, bytes, mtimeMs: Date.now() }
    for (const f of files) {
      if (records.length >= LIMIT) break
      try {
        const got = await (deps.readRecords || readRecords)(f, { limit: LIMIT - records.length })
        for (const rec of got) records.push(rec)
        // a sealed file read only in part is a read error, and leaves a journal entry
        const p = sealedReadProblem(got.scan)
        if (p) readErrors.push(`${f}: ${p.unreadableRecords ?? 'all'} record(s) could not be read - ${p.reason}`) // `doctor` writes nothing (§3.7): the problem is reported, never recorded
      } catch (e) { readErrors.push(`${f}: ${(e && e.message) || e}`) }
    }
  }
  return { sources, files, extra, records, srcMeta, readErrors }
}

/** The things `doctor` looked at and could not judge (附录 C.4 `undetermined`), in English, from the structured result — never a reason string of another module. */
function undeterminedOf(res, readErrors, { files = 0, records = 0, root = null } = {}) {
  const out = []
  // whether the root is trusted is ONE check, the one `status` and `install` use (the collector's root store): `unknown` is the only
  // verdict doctor cannot judge, and it carries its own English reason (a Windows test machine 2026-10-18: a second, unimplemented check printed
  // "win32 TrustStoreInstaller not implemented (D22 reserved …)" at a person while install had just written the root)
  if (root && root.state === 'unknown') out.push({ what: 'the user trust store', reason: root.reason })
  if (res.q4b.checked === 0) out.push({ what: 'file permissions', reason: 'no captured data yet' }) // §3.7: having no captured data is not 「cannot judge」
  if (res.q4b.unreadable.length) out.push({ what: 'file permissions', reason: `the permissions of ${res.q4b.unreadable.length} file(s) could not be read` })
  // a capture file that is there and yielded no record at all: the read failed without saying so (the D27 array-source defect certified a capture it had read nothing from)
  if (files > 0 && records === 0) out.push({ what: 'the captured records', reason: `${files} capture file(s) are there and no record could be read from them` })
  for (const e of readErrors) out.push({ what: 'a captured file', reason: e })
  return out
}
/** Only these keep `doctor` from judging (exit 3). No captured data yet does not. */
const realUndetermined = (u) => u.filter((x) => x.reason !== 'no captured data yet')

/** The 附录 C.4 document. `status`'s own document is folded in under `status`, so one read answers both. */
export async function doctorDoc({ names = null, home = nodeOs.homedir(), env = process.env, platform = process.platform, deps = {} } = {}) {
  // one command, one answer per OS question (D62 task E): the trailing capture-health read asks the daemon pid's identity again. The scope is
  // opened HERE, so it is this one that carries the daemon read client statusFacts would otherwise open its own scope with (it is re-entrant).
  const reader = deps.daemonReader !== undefined ? deps.daemonReader : daemonProcReader({ platform, dir: collectorDir(home), env, fs: deps.fs || nodeFs, ...(deps.request ? { request: deps.request } : {}), ...(deps.socketPath !== undefined ? { socketPath: deps.socketPath } : {}) })
  return memoProcQuestions({ reader }, () => doctorDocOf({ names, home, env, platform, deps: { ...deps, daemonReader: reader } }))
}
async function doctorDocOf({ names, home, env, platform, deps }) {
  const fs = deps.fs || nodeFs
  // the capture half of this command is sixteen modules `status` never touches (D62): start loading it, then ask the OS — it compiles while the daemon answers
  const capture = deps.capture || import('./doctor-deps.mjs')
  // the capture files and what `status` reads are independent: the disk walk and the OS questions run together (D62 task E)
  const [c, f] = await Promise.all([collect({ home, env, sourceFlags: [], deps, capture }), statusFacts({ names, home, env, platform, deps })])
  const { checkDeps, runSelfTest, orphanBackups, checkStandalone } = await capture
  const depList = checkDeps({ platform, has: deps.has || ((bin) => onPath(bin, { env, platform, fs })) })
  const res = runSelfTest({ records: c.records, srcMeta: c.srcMeta, deps: depList, files: [...c.files, ...c.extra], readErrors: c.readErrors, platform })
  const status = statusDocOf(f)
  let findings = null, findingsError = null
  // the same facts were already diagnosed once, to put each harness's codes on its topology (gatherTopology): with no harness named this is
  // that very list, and diagnosing it twice is one command asking one question twice (D62). A named harness asks its own, narrower question.
  if (f.facts) { try { findings = (!names || !names.length) && f.diagnosed ? f.diagnosed : diagnose({ facts: f.facts, topology: f.topology, harnesses: names, user: f.user }) } catch (e) { rethrowSandbox(e); findingsError = errText(e) } }
  else findingsError = f.topology_error || 'the network facts could not be read on this platform'
  // what `doctor` looks at besides the network: the files only you may read, the copy of the undo program, the backups no install record names
  const extra = []
  for (const bad of res.q4b.bad) extra.push({ code: 'file-readable-by-others', class: 'problem', what: `${bad.file} (mode ${bad.mode}) can be read by someone else, and captured files hold live credentials.`, why: 'Only you may read what trocar captured.', commands: [{ run: `chmod 600 ${shq(bad.file)}`, shell: 'sh' }], verify: 'trocar doctor' })
  // the copy of the undo program is `install`'s; a machine where nothing was installed has nothing to check (§3.7)
  const installed = !!(status.install && status.install.state)
  const standalone = installed ? (() => { try { return checkStandalone({ home, platform, fs }) } catch (e) { rethrowSandbox(e); return { ok: false, error: errText(e) } } })() : { ok: true }
  if (standalone.error) extra.push({ code: 'standalone-unreadable', class: 'problem', what: 'The standalone undo program could not be checked.', why: standalone.error, commands: [{ run: 'trocar install', shell: 'sh' }], verify: 'trocar doctor' })
  else if (!standalone.ok) extra.push({ code: 'standalone-stale', class: 'problem', what: `${standaloneCommand(standalone.path, platform)} is not the current version, so it may not undo everything.`, why: standalone.reason || 'its bytes are not the ones this trocar writes', commands: [{ run: 'trocar install', shell: 'sh' }], verify: 'trocar doctor' })
  let orphans = [], orphansError = null
  try { const m = readManifest(collectorDir(home), fs); orphans = m && m.unsupported ? null : orphanBackups({ home, manifest: m, fs }); if (orphans === null) orphansError = 'the install record is of a version this trocar does not read, so which backups it names cannot be said' } catch (e) { orphansError = `${manifestPath(collectorDir(home))}: ${errText(e)}` }
  if (orphans && orphans.length) extra.push({ code: 'backup-unclaimed', class: 'note', what: `${orphans.length} backup file(s) belong to no install record.`, why: 'An edit that was interrupted left them behind.', commands: [{ run: `Look at them, then remove them: ${orphans[0]}`, shell: 'sh' }], verify: 'trocar doctor' })
  if (orphansError) extra.push({ code: 'backup-unclaimed', class: 'note', what: `Whether any backup belongs to no install record is ${unknown(orphansError)}.`, why: 'The install record could not be read.', commands: [], verify: 'trocar doctor' })
  const all = findings === null ? null : [...extra.filter((x) => x.class === 'problem'), ...findings, ...extra.filter((x) => x.class !== 'problem')]
  const summary = all === null ? null : { problem: all.filter((x) => x.class === 'problem').length, expected: all.filter((x) => x.class === 'expected').length, note: all.filter((x) => x.class === 'note').length }
  const undetermined = undeterminedOf(res, c.readErrors, { files: c.files.length, records: c.records.length, root: (status.cert || {}).root || null })
  const exit = summary && summary.problem ? EXIT.incomplete : realUndetermined(undetermined).length ? EXIT.unknown : EXIT.ok
  let notes = []
  // the capture health `status` already read of the same files (gatherStatus): one command, one read (D62). A read that failed is `null` there and
  // is already reported in `status.errors` — it must not be tried again here, where its failure would have nowhere to go.
  try { notes = f.health ? formatInstallNotes(f.health) : [] } catch (e) { rethrowSandbox(e) }
  return {
    ...newReceipt('doctor'), ok: exit === EXIT.ok, findings: all, ...(findingsError ? { findings_error: findingsError } : {}),
    summary, undetermined, status, install_notes: notes, errors: [...c.readErrors.map((e) => ({ where: 'a captured file', reason: e })), ...(status.errors || [])], exit,
  }
}

/** → the exit code. `argv` is what follows `doctor`; `io` = { out, err }. */
export async function runDoctor(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  let json = false
  const names = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a.startsWith('-')) { io.err(`trocar doctor: unknown option '${a}'\n${USAGE}`); return EXIT.usage }
    else names.push(a)
  }
  const named = resolveHarnesses(names)
  if (!named.ok) { io.err(`trocar doctor: unknown harness '${named.unknown.join(', ')}'. Known: ${named.known.join(', ')}`); return EXIT.usage }
  const doc = await doctorDoc({ names: named.ids, home, env, platform, deps })
  const { exit } = doc
  if (json) { const { exit: _drop, ...out } = doc; io.out(JSON.stringify(out, null, 2)); return exit }
  const s = doc.summary
  // §3.7: the headline says what the list below it numbers — problems AND the expected findings (a Windows test machine 2026-10-18:
  // "1 problem." over three numbered entries). Notes are not numbered, so they are not counted here. The exit code is unchanged.
  const headline = (x) => {
    if (!x.problem && !x.expected) return 'trocar doctor: no problems.'
    const parts = []
    if (x.problem) parts.push(`${x.problem} problem${x.problem === 1 ? '' : 's'}`)
    if (x.expected) parts.push(`${x.expected} expected finding${x.expected === 1 ? '' : 's'}`)
    return `trocar doctor: ${parts.join(' and ')}.`
  }
  io.out(s === null ? `trocar doctor: findings are ${unknown(doc.findings_error)}.` : headline(s))
  if (doc.findings && doc.findings.length) { io.out(''); for (const l of renderFindings(doc.findings)) io.out(l) }
  for (const u of realUndetermined(doc.undetermined)) io.out(`Could not judge ${u.what}: ${u.reason}`)
  for (const u of doc.undetermined.filter((x) => x.reason === 'no captured data yet')) io.out(`${u.what.replace(/^./, (m) => m.toUpperCase())}: no captured data yet`)
  if (doc.install_notes.length) { io.out(''); for (const l of doc.install_notes) io.out(l) }
  return exit
}
