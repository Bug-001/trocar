// wrapper.mjs — the 4.11 P8 install-folder wrapper, the OS-free half: which program may be wrapped, placing the wrapper, undoing it and
// judging it for `status`. The arch gives the wrapper's bytes (`renderWrapper`: macOS's dash script; Windows's C# source, which
// `compile` turns into the stub) and the platform facts (`exeSuffix`). A descriptor's cert reads
//   { kind:'wrapper', command, binDir: <loc>, certVar, layout:'native-binary' }.
// Placement: the real program is renamed, in its own folder (so on the same volume), to <binDir>/.trocar-real/<same name>, and the wrapper is
// written where it was; the manifest's owned file (role `wrapper`) carries both sha256 values (T11's shape: path, sha256, real, real_sha256).
// The agent's own update replaces <binDir>/<name> by name and so lands on the wrapper; the real program in .trocar-real is then stale, which
// undo and status handle by the hash alone.
import nodeFs from 'node:fs'
import path from 'node:path'
import { resolveLoc } from '../sources.mjs'
import { sha256, readOrNull } from '../../../../off/fsutil.mjs'
import { undoWrapper as undoWrapperItem } from '../../../../off/journal.mjs'
import { writeOwnedFile } from '../../trust/journal.mjs'
import { CODE } from '../../codes.mjs'

export const REAL_DIR = '.trocar-real'
const NOT_USERS_FILE = CODE.notUsersFile
const SMART_APP_CONTROL = 'smart-app-control'

// Package-manager trees: a program under any of these folders is the package manager's file, rewritten by it at every update (4.11 P8:
// such a CLI takes `plugin` or is unsupported). Matched as whole path segments, case-folded. The one list of them.
export const PACKAGE_MANAGER_TREES = Object.freeze(['node_modules', '.npm', '.npm-global', '.pnpm', 'pnpm', '.yarn', '.bun', '.volta', '.nvm', '.fnm', 'nvm', 'Cellar', 'Caskroom', 'homebrew', 'linuxbrew', 'scoop', 'chocolatey', 'WinGet', '.cargo', '.local/pipx', 'pipx'])
// System trees: the OS's and the system package managers' own folders, matched as a path prefix (case-folded, either slash). A file there is never
// this user's to edit, whoever its owner is (rule U, P8).
export const SYSTEM_TREES = Object.freeze(['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/private/etc', '/opt/homebrew', '/opt/local', 'C:/Windows', 'C:/Program Files', 'C:/Program Files (x86)', 'C:/ProgramData'])

/** The package-manager or system tree `file` is inside, or null (one judge for the wrapper and rule U). */
export function managedTree(file) {
  const norm = String(file).replace(/\\/g, '/').toLowerCase()
  const sys = SYSTEM_TREES.find((t) => norm === t.toLowerCase() || norm.startsWith(`${t.toLowerCase()}/`))
  if (sys) return sys
  const segs = norm.split('/')
  return PACKAGE_MANAGER_TREES.find((p) => { const ps = p.toLowerCase().split('/'); return segs.some((_, i) => ps.every((s, j) => segs[i + j] === s)) }) || null
}

// Native executables by their first bytes: Mach-O 64-bit in either byte order, a universal (fat) Mach-O, a PE ('MZ').
const MAGIC = [[0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0x4d, 0x5a]]
const isNative = (head) => MAGIC.some((m) => m.every((b, i) => head[i] === b))

function headOf(fs, file, n = 4) {
  const fd = fs.openSync(file, 'r')
  try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, got) } finally { fs.closeSync(fd) }
}

/** Where the wrapper goes: <binDir>/<command><exeSuffix> (`file`; the real program moved aside: `real`), or null when binDir does not resolve. */
export function targetOf(ctx, cert) {
  const dir = resolveLoc(cert.binDir, ctx)[0]
  if (!dir) return null
  const join = ctx.join || path.join
  const name = `${cert.command}${(ctx.facts && ctx.facts.exeSuffix) || ''}`
  return { dir, name, file: join(dir, name), real: join(dir, REAL_DIR, name) }
}

/** Whether the target is this user's own native program the wrapper may stand in for (4.11 P8 preconditions). → { ok:true, target } | { code:'not-users-file', why } */
export function checkWrapperTarget(ctx, cert) {
  const fs = ctx.fs || nodeFs
  const no = (why) => ({ code: NOT_USERS_FILE, why })
  if (cert.layout !== 'native-binary') return no(`the descriptor does not declare that ${cert.command}'s updates replace one native program by name (layout ${JSON.stringify(cert.layout ?? null)})`)
  const t = targetOf(ctx, cert)
  if (!t) return no(`the folder of ${cert.command} does not resolve here`)
  const tree = managedTree(t.file)
  if (tree) return no(`${t.file} is inside a package manager's or the system's tree (${tree}), which rewrites it at every update`)
  let st
  try { st = fs.lstatSync(t.file) } catch { return no(`${t.file} does not exist`) }
  if (st.isSymbolicLink()) return no(`${t.file} is a link to a program managed elsewhere`)
  if (!st.isFile()) return no(`${t.file} is not a file`)
  let head
  try { head = headOf(fs, t.file) } catch (e) { return no(`${t.file} cannot be read (${e.code || e.message})`) }
  if (!isNative(head)) return no(`${t.file} is not one native program (it starts ${JSON.stringify(head.toString('latin1'))}): a script or a launcher`)
  let owns
  try { owns = typeof ctx.owns === 'function' ? ctx.owns(t.dir) : null } catch { owns = null }
  if (owns !== true) return no(owns === false ? `${t.dir} belongs to another user` : `who owns ${t.dir} cannot be told`)
  return { ok: true, target: t }
}

const recordOf = (manifest, file) => (manifest.files || []).find((f) => f.role === 'wrapper' && f.path === file) || null

/** Install the wrapper. → { ok:true, result:'placed'|'intact', record } | { skipped:true, code, why } */
export function placeWrapper(ctx, cert, { renderWrapper, compile = null, sacOn = false }) {
  const fs = ctx.fs || nodeFs
  const t = targetOf(ctx, cert)
  const rec = t && recordOf(ctx.manifest, t.file)
  const cur = t && readOrNull(fs, t.file)
  if (rec && cur != null && sha256(cur) === rec.sha256) return { ok: true, result: 'intact', record: rec }
  if (sacOn) return { skipped: true, code: SMART_APP_CONTROL, why: 'Smart App Control is on: it would block an unsigned wrapper, so trocar places none' }
  const c = checkWrapperTarget(ctx, cert)
  if (!c.ok) return { skipped: true, ...c }
  // .trocar-real/<name> is overwritten only when this target's own record names it (the installer replaced the wrapper, so the copy there is
  // stale). Without that record it may hold the user's only real program, under a wrapper whose record is gone: never move anything onto it.
  if (fs.existsSync(t.real) && !(rec && rec.real === t.real)) return { skipped: true, code: NOT_USERS_FILE, why: `${t.real} already holds a program trocar has no record of; trocar will not overwrite it` }
  const values = { REAL: t.real, SWITCH: ctx.switchFile, CA_FILE: ctx.caFile, CERT_VAR: cert.certVar, PROXY_ENV: ctx.proxyEnv || [], PROXY_NAMES: ctx.proxyNames || [] }
  const source = renderWrapper(values)
  const data = compile ? compile(source) : source // render before any move: a template error leaves the program where it was
  const realBytes = fs.readFileSync(t.file)
  const realMode = fs.statSync(t.file).mode & 0o777
  fs.mkdirSync(path.dirname(t.real), { recursive: true })
  fs.renameSync(t.file, t.real) // same folder tree, same volume: a rename, never a copy
  try {
    writeOwnedFile({ dir: ctx.dir, manifest: ctx.manifest, harness: ctx.harness, role: 'wrapper', phase: 'install', file: t.file, data, mode: realMode | 0o500, now: ctx.now ? ctx.now() : new Date(), fs, extra: { real: t.real, real_sha256: sha256(realBytes) } })
  } catch (e) {
    try { fs.rmSync(t.file, { force: true }); fs.renameSync(t.real, t.file) } catch { /* reported below; undo by hand names the move */ }
    throw e
  }
  return { ok: true, result: 'placed', record: recordOf(ctx.manifest, t.file) }
}

/** Undo (uninstall): the real program goes back only while the wrapper is still trocar's; otherwise only .trocar-real goes. */
export const undoWrapper = (ctx, record) => undoWrapperItem(record, ctx.fs || nodeFs)

/** Status of a placed wrapper: null while intact; a drift → entry-changed with the command that puts it back. */
export function checkWrapper(ctx, record) {
  const cur = readOrNull(ctx.fs || nodeFs, record.path)
  if (cur == null) return { reason: 'entry-missing', path: record.path, command: 'trocar install' }
  if (sha256(cur) !== record.sha256) return { reason: 'entry-changed', path: record.path, command: 'trocar install', why: `${record.path} is no longer trocar's wrapper (the agent's installer or update replaced it)` }
  return null
}
