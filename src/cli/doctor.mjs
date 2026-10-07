// doctor.mjs — `asight doctor [harness…] [--source F|DIR] [--json]` (RFC 1.6 §2, R4, R11; 4.1 §凭据处置): the self-check an operator runs when something looks wrong. It answers the four questions
// of the 「测试」(is it capturing · is what it captured right · no credential outside the files · no machine-wide TLS weakening) and ④b (every file that holds captured bytes is owner-only), and it
// folds in what `asight verify` was (the old CA is in the user trust store only). Then it prints, read-only, what `status` knows (the daemon, every harness, the VPN software) and what the last
// install noted, the standalone undo copy, and the backups no manifest names. It never changes a thing of the user's and starts nothing: its OS queries are read-only (`ps`, the trust-store
// lookup, the process table); the files it may write are `status`'s ~/.asight/netenv.json and, when a sealed capture file could only be read in part, one line in ~/.asight/raw/journal.jsonl.
//
// Exit (R4): 1 — a capture file others can read (「采集文件可被他人读取」: the bytes hold live API keys) · 3 — it could not judge: no records examined, no file's permissions examined, a file whose permissions
// could not be read, a capture file only partly read — never 0 (reading nothing and answering 「过」 is what this command once did, 0.1 §3) · 0 — the rest. The status block is a report and
// does not change the exit (review B-7). Everything the world gives is a `deps` entry a test replaces (0.1 §3): `has(bin)` (dependency probe), `verify()` (the trust-store check), and the
// ones `runStatusCli` takes (`request`, `procs`, `netenv`, `lingerRead`, …). With none, `has` looks at PATH, `verify` asks the user trust store of THIS home, everything else is real.
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { EXIT, newReceipt } from './schema.mjs'
import { resolveHarnesses } from './harness-names.mjs'
import { runStatusCli } from './status.mjs'
import { checkDeps, runSelfTest } from '../capture/selftest.mjs'
import { verifyUserTrustOnly } from '../capture/onboard.mjs'
import { readRecords } from '../etl/ingest.mjs'
import { serveSource } from '../paths.mjs'
import { appendJournal, sealedReadProblem } from '../raw/journal.mjs'
import { exportFiles } from '../raw/export.mjs'
import { sealedUnder } from '../raw/discover.mjs'
import { captureHealth } from '../health/read.mjs'
import { formatInstallNotes } from '../collector/cli.mjs'
import { asightHome, backupDir, collectorDir } from '../off/paths.mjs'
import { orphanBackups } from '../off/backup.mjs'
import { readManifest, manifestPath } from '../off/manifest.mjs'
import { checkStandalone } from '../off/standalone.mjs'

const USAGE = 'usage: asight doctor [harness…] [--source <ndjson|dir>] [--json]'
const LIMIT = 5000 // records sampled (the head of the capture)
const rethrowSandbox = (e) => { if (e && e.code === 'ESANDBOX') throw e } // a refusal of the test guard is never "the tool failed" (0.1 §3)
const errText = (e) => String((e && (e.code || e.message)) || e)
const mark = (ok, warn) => (ok ? '✓' : warn ? '⚠' : '✗')
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

/** The regular files directly in `dir` (the backups: asight made them 0600 in a 0700 directory). A directory that is not there is no files; one that cannot be listed is `error`. */
function filesIn(dir, fs) {
  try { return { files: fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(dir, e.name)) } } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? { files: [] } : { files: [], error: `${dir}: ${errText(e)}` }
  }
}

/** The capture files, sampled records and everything ④b has to look at → { sources, files, extra, records, srcMeta, readErrors }. One resolver for the source, shared with the board (src/server.mjs sourceFiles):
 *  a root is usually a DIRECTORY and `serveSource()` returns a list of them (D27) — the day `fs.statSync(list)` threw, the catch swallowed it and doctor certified a capture it had read nothing from. */
async function collect({ home, env, sourceFlags, deps }) {
  const fs = deps.fs || nodeFs, ah = asightHome(home)
  const flagged = sourceFlags.filter(Boolean)
  const sources = [].concat(flagged.length ? flagged : env.ASIGHT_SOURCE || serveSource({ home: ah, legacy: path.join(home, '.atrace', 'asight'), collector: collectorDir(home) })).filter(Boolean)
  const sessionsRoot = path.join(ah, 'sessions')
  const files = [], extra = [], records = [], readErrors = []
  const { sourceFiles } = deps.sourceFiles ? { sourceFiles: deps.sourceFiles } : await import('../server.mjs')
  for (const root of sources) {
    try {
      const part = sourceFiles(root, { sessionsRoot })
      files.push(...part.files)
      extra.push(...part.superseded.map((x) => x.sealed)) // sealed copies superseded by an original that still exists hold the same credentials (D35)
    } catch (e) { readErrors.push(`${root}: ${(e && e.message) || e}`) }
  }
  // a directory that exists and cannot be listed is a read error (无法判定), never "no files": a mode-000 export dir holding a 0644 capture would otherwise be certified owner-only (0.1 §3, R11)
  const unlistable = (d, e) => readErrors.push(`${d}: ${errText(e)}`)
  extra.push(...exportFiles(path.join(ah, 'export'), { fs, onError: unlistable })) // the default export dir (D35 · 4.1 §凭据处置)
  extra.push(...sealedUnder(sessionsRoot, { fs, onError: unlistable }).filter((f) => !files.includes(f))) // every sealed file `asight raw seal` filed by session, whichever source it continues
  const backups = filesIn(backupDir(home), fs) // what asight saved of the user's files before changing them: settings with tokens in them (R2)
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
        if (p) { readErrors.push(`${f}: ${p.unreadableRecords ?? 'all'} record(s) unreadable — ${p.reason}`); appendJournal({ op: 'read', reader: 'doctor', outcome: 'failed', ...p }, { journal: path.join(ah, 'raw', 'journal.jsonl') }) }
      } catch (e) { readErrors.push(`${f}: ${(e && e.message) || e}`) }
    }
  }
  return { sources, files, extra, records, srcMeta, readErrors }
}

/** `asight status` for the same harnesses, captured: `{ lines, exit }` or, in JSON, `{ json, exit }`. Its failures are text here, never a thrown error (a refusal of the test guard excepted). */
async function statusBlock({ names, json, env, home, platform, deps }) {
  const out = [], err = []
  const io = { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)), stdin: null, stdout: null }
  try {
    const exit = await runStatusCli([...names, ...(json ? ['--json'] : [])], { io, env, home, platform, deps })
    if (json) { try { return { json: JSON.parse(out.join('\n')), exit } } catch { return { json: { error: 'asight status printed no JSON', output: out.join('\n') }, exit } } }
    return { lines: [...out, ...err], exit }
  } catch (e) { rethrowSandbox(e); const msg = `collector status could not be read: ${(e && e.message) || e}`; return json ? { json: { error: msg }, exit: EXIT.unknown } : { lines: [msg], exit: EXIT.unknown } }
}

/** → the exit code. `argv` is what follows `doctor`; `io` = { out, err } (src/off/io.mjs makeIo). */
export async function runDoctor(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  let json = false
  const sourceFlags = [], names = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--source') { if (i + 1 >= argv.length) { io.err(`asight doctor: --source needs a file or a directory\n${USAGE}`); return EXIT.usage } sourceFlags.push(argv[++i]) }
    else if (a.startsWith('--source=')) sourceFlags.push(a.slice('--source='.length))
    else if (a.startsWith('-')) { io.err(`asight doctor: unknown option ${a}\n${USAGE}`); return EXIT.usage }
    else names.push(a)
  }
  const named = resolveHarnesses(names)
  if (!named.ok) { io.err(`asight doctor: unknown harness ${named.unknown.join(', ')}; the names are: ${named.known.join(', ')}`); return EXIT.usage }
  const fs = deps.fs || nodeFs
  const c = await collect({ home, env, sourceFlags, deps })
  for (const e of c.readErrors) io.err(`read error: ${e}`) // a read failure MUST be visible: a silently swallowed error is what let ③ pass vacuously
  const depList = checkDeps({ platform, has: deps.has || ((bin) => onPath(bin, { env, platform, fs })) })
  // ④ the old `verify`: the CA is in the user's trust store only. This home's keychain / NSS db, never the real one of whoever runs a test
  const installerOpts = { keychain: path.join(home, 'Library', 'Keychains', 'login.keychain-db'), nssdb: path.join(home, '.pki', 'nssdb') }
  const res = runSelfTest({ records: c.records, srcMeta: c.srcMeta, deps: depList, files: [...c.files, ...c.extra], readErrors: c.readErrors, verify: deps.verify || (() => verifyUserTrustOnly({ platform, installerOpts })) })
  const exit = res.failed ? EXIT.incomplete : res.undetermined ? EXIT.unknown : EXIT.ok
  // the rest is a report
  const block = await statusBlock({ names, json, env, home, platform, deps })
  let notes = [], notesError = null
  try { notes = formatInstallNotes((deps.captureHealth || captureHealth)({ home: asightHome(home), ...(deps.captureHealth ? {} : { fs }) })) } catch (e) { rethrowSandbox(e); notesError = errText(e) }
  const standalone = (() => { try { return checkStandalone({ home, fs }) } catch (e) { rethrowSandbox(e); return { ok: false, error: errText(e) } } })()
  let orphans = [], orphansError = null
  try { const m = readManifest(collectorDir(home), fs); orphans = m && m.unsupported ? null : orphanBackups({ home, manifest: m, fs }); if (orphans === null) orphansError = 'the install manifest is of a version this build does not know, so which backups it names cannot be said' } catch (e) { orphansError = `${manifestPath(collectorDir(home))}: ${errText(e)}` }

  if (json) {
    io.out(JSON.stringify({
      ...newReceipt('doctor'), ok: exit === EXIT.ok, exit, verdict: res.failed ? 'failed' : res.undetermined ? 'undetermined' : 'ok', undetermined_why: res.undeterminedWhy,
      source: c.sources, records_examined: c.records.length, capture_files_checked: res.q4b.checked, readable_by_others: res.q4b.bad, unreadable: res.q4b.unreadable, read_errors: c.readErrors,
      questions: { capturing: { ok: res.q1.ok, note: res.q1.note }, correct: { ok: res.q2.ok, note: res.q2.note }, credentials: { ok: res.q3.ok, note: res.q3.note }, user_trust_only: { ok: res.q4.ok, note: res.q4.note }, file_permissions: { ok: res.q4b.ok, note: res.q4b.note } },
      deps: depList, status: block.json, install_notes: notesError ? { error: notesError } : notes, standalone: standalone.error ? { ok: false, error: standalone.error } : { ok: standalone.ok, path: standalone.path, found: standalone.found, expected: standalone.expected, ...(standalone.reason ? { reason: standalone.reason } : {}) },
      orphan_backups: orphansError ? { error: orphansError } : orphans,
    }, null, 2))
    return exit
  }

  const source = c.sources.join(', ') || '(none)'
  io.out('asight doctor — onboard 自检(依赖探测 + 「测试」四问)\n')
  io.out('deps:')
  for (const d of depList) io.out(`  ${mark(d.present, true)} ${d.bin} — ${d.present ? 'found' : `MISSING · ${d.hint}`} (${d.why})`)
  io.out(`\n源:${source}${c.srcMeta.exists ? ` · ${(c.srcMeta.bytes / 1024).toFixed(0)} KB${c.records.length >= LIMIT ? ` · sampled first ${LIMIT} records` : ''}` : ' · (not found)'}\n`)
  io.out('四问(人核对):')
  io.out(`  ${mark(res.q1.ok, true)} ① 是否真在抓   — ${res.q1.note}`)
  io.out(`  ${mark(res.q2.ok, res.q2.llm === 0)} ② 抓得对       — ${res.q2.note}`)
  io.out(`  ${res.q3.ok ? '✓' : '?'} ③ 凭据没漏     — ${res.q3.note}`)
  io.out(`  ${mark(res.q4.ok, true)} ④ 没弱化全机 TLS — ${res.q4.note}`)
  io.out(`  ${res.q4b.ok ? '✓' : res.failed ? '✗' : '?'} ④b 采集文件仅属主可读 — ${res.q4b.note}`)
  // 4.6 §确认信任 / §合并包: the same text as `asight status` (the live daemon when it answers, else what is on disk), then the notes of the last install; it only reads and never changes the exit
  io.out('\n按进程采集器(collector, 4.6):')
  for (const l of block.lines) io.out(indent(l))
  if (notesError) io.out(indent(`the last install's notes could not be read: ${notesError}`))
  else for (const l of notes) io.out(indent(l))
  // 1.6 R3 / V35: the copy of the undo side that needs no source tree is the version this asight writes (read only; `asight on` writes it again)
  if (standalone.error) io.out(indent(`⚠ asight-off 副本无法核对: ${standalone.error}`))
  else io.out(indent(standalone.ok ? `✓ asight-off(不依赖源码的撤销副本): ${standalone.path} · 版本 ${standalone.found},与当前一致` : `⚠ asight-off(不依赖源码的撤销副本)不是当前版本: ${standalone.reason}`))
  if (orphansError) io.out(indent(`备份: 不知道(${orphansError})`))
  else if (orphans.length) io.out(indent(`⚠ ${orphans.length} 个备份没有任何清单条目认领(改文件改到一半断了留下的;留着或不要了就删,asight uninstall 会清掉): ${orphans.join(', ')}`))
  if (res.failed) {
    io.err('\n✗ 采集文件可被他人读取 — these files hold live API credentials (stored verbatim, by design); only their owner may read them. Fix the permissions (chmod 600, see ④b above) before capturing further.')
  } else if (res.undetermined) {
    io.err(`\n? 无法判定(exit 3) — ${res.undeterminedWhy.join(';')}。\n  没核到就不能说「采集文件的权限已经核过」:先让采集跑起来(asight on,再用一次 agent),或用 --source 指到有采集文件的地方,再跑 asight doctor。`)
  } else {
    io.out('\n✓ 采集文件仅属主可读;凭据逐字存储 = 设计如此。(①②③④ 供你核对 — 见上方说明)')
  }
  return exit
}
