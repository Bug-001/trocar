// src/rules/file.mjs — rules.json on disk (5.1 §住哪, §隔离): how it is read, and the one edit() every writer goes through. Only the file: telling the
// daemon is the caller's (POST /rules/reload).
//   • Several writers (the operator, the agents the operator opened, the board), so unlike classes.json an edit holds rules.lock from read to rename: an
//     unlocked read-modify-write lets a stale `rules enable` undo a `rules off` and still report success.
//   • The lock's rules are short because an edit takes milliseconds: wait at most 2 s; a lock older than 2 s is taken whoever holds it; so a writer checks
//     it still holds the lock right before the rename, and gives up if not.
//   • The path is not trusted: stat first, open without blocking, read a bounded prefix. A FIFO, a device or a huge file is a bad file, never a hang.
import nodeFs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { rulesFile, rulesLock, rulesLog } from '../paths.mjs'
import { sha256, writeDurable } from '../off/fsutil.mjs'
import { checkFile, parseRulesBytes, LIMITS, DEFAULT_MAX_DELAY_MS } from './validate.mjs'

const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 2000
const LOCK_NAP_MS = 10
const TOKEN_BYTES = 16

/** Thrown by an edit's `fn` to give the edit up; `code` and `message` become the result's `error` as they are. */
export class RuleRefused extends Error {
  constructor(code, message) { super(message); this.code = code }
}

const notRegular = () => Object.assign(new Error('not a regular file'), { code: 'not-regular' })

/** At most `limit` bytes of a regular file. Throws for anything else, the file's own error or `not-regular`. A path swapped for a FIFO after the stat
 *  still cannot block: O_NONBLOCK, then fstat what was opened. */
export function readBounded(fs, file, limit) {
  if (!fs.statSync(file).isFile()) throw notRegular()
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0))
  try {
    if (!fs.fstatSync(fd).isFile()) throw notRegular()
    const buf = Buffer.allocUnsafe(limit)
    let got = 0
    for (let n; got < limit && (n = fs.readSync(fd, buf, got, limit - got, got)) > 0;) got += n
    return buf.subarray(0, got)
  } finally { fs.closeSync(fd) }
}

/** The delay a broken file still says, the default if it is an object that says none, undefined when it cannot be told. */
function delayOf(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return undefined
  const delay = doc.max_delay_ms ?? DEFAULT_MAX_DELAY_MS
  return checkFile({ max_delay_ms: delay, rules: [] }).length ? undefined : delay
}

/**
 * The rule file now → `{state, doc, sha256, problem?}`. `state` is `absent`, `ok` or `bad`; `problem` is `{code, reason}` with `code` not-regular, unreadable,
 * too-big, too-deep, not-json or invalid. `doc` is always a usable document: when `bad` it has no rules and the delay the file still says, and `kept_delay`
 * is false if it could not say. `sha256` is of the file's bytes, null when there are none or only a prefix was read.
 */
export function readRules({ home, fs = nodeFs } = {}) {
  const empty = { max_delay_ms: DEFAULT_MAX_DELAY_MS, rules: [] }
  const bad = (problem, hash = null, parsed) => {
    const delay = delayOf(parsed)
    return { state: 'bad', doc: { ...empty, max_delay_ms: delay ?? DEFAULT_MAX_DELAY_MS }, sha256: hash, problem, kept_delay: delay !== undefined }
  }
  let bytes
  try { bytes = readBounded(fs, rulesFile(home), LIMITS.fileBytes + 1) } catch (e) {
    if (e.code === 'ENOENT') return { state: 'absent', doc: empty, sha256: null }
    return bad({ code: e.code === 'not-regular' ? e.code : 'unreadable', reason: e.message })
  }
  const hash = bytes.length > LIMITS.fileBytes ? null : sha256(bytes)
  const { doc, problem } = parseRulesBytes(bytes)
  if (problem) return bad(problem, hash)
  const [first] = checkFile(doc)
  if (first) return bad({ code: 'invalid', reason: `${first.path}: ${first.reason}` }, hash, doc)
  return { state: 'ok', doc: { ...empty, ...doc }, sha256: hash }
}

const holds = (fs, lock, token) => {
  try { return readBounded(fs, lock, token.length + 1).toString() === token } catch { return false }
}

/** Removes the lock if it has aged out. Goes by way of a private name: of two takers the slower one renames the lock the faster has just made, sees it is
 *  fresh and puts it back. Should a third writer get in first, the faster one finds its lock gone before its rename and gives up: never two writers. */
function takeStale(fs, lock, token) {
  const stale = (file) => Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS
  const aside = `${lock}.stale-${token}`
  try {
    if (!stale(lock)) return
    fs.renameSync(lock, aside)
    if (!stale(aside)) try { fs.linkSync(aside, lock) } catch { /* see above */ }
    fs.unlinkSync(aside)
  } catch (e) { if (e.code !== 'ENOENT') throw e } // the lock went while looking at it: the next try gets it
}

/** Holds rules.lock → the token that says so, or null when the wait ran out. */
function takeLock(fs, lock) {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 }); return token } catch (e) { if (e.code !== 'EEXIST') throw e }
    takeStale(fs, lock, token)
    if (Date.now() >= deadline) return null
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_NAP_MS)
  }
}

const dropLock = (fs, lock, token) => {
  try { if (holds(fs, lock, token)) fs.unlinkSync(lock) } catch { /* it ages out, and the edit's result is what matters */ }
}

/** The names of the rules an edit added, removed or changed. */
function changedRules(before, after) {
  const text = (doc) => new Map(doc.rules.map((r) => [r.name, JSON.stringify(r)]))
  const a = text(before), b = text(after)
  return [...new Set([...a.keys(), ...b.keys()])].filter((name) => a.get(name) !== b.get(name))
}

/**
 * The one way to change the rule file. Under rules.lock: read, `fn(doc)` → the new doc, check, rename, one line in logs/rules.ndjson.
 * → `{ok, before, after, written, invalid?, error?, log_failed?, kept_delay?}`. `fn` may throw RuleRefused to give up; `invalid` lists what the new doc
 * fails; `error.code` is otherwise `rules-unwritable`, and that covers a bad file too unless `onBad` is `aside` (`rules off`): the bad file is renamed to
 * rules.json.bad-<time> by the write, `fn` gets no rules and the delay it still says, and `kept_delay` says whether it could say. `dryRun` stops before the
 * write with `before` and `after` filled in. A change the log could not record is still `ok`, with `log_failed` the reason.
 */
export function edit(fn, { home, fs = nodeFs, now = () => new Date(), source = 'cli', op, dryRun = false, onBad = 'refuse' } = {}) {
  const file = rulesFile(home), lock = rulesLock(home)
  const unwritable = (message, rest) => ({ ok: false, written: [], ...rest, error: { code: 'rules-unwritable', message } })
  let token
  try { token = takeLock(fs, lock) } catch (e) { return unwritable(`${lock} could not be made (${e.message})`) }
  if (!token) return unwritable(`${lock} stayed held for ${LOCK_WAIT_MS} ms`)
  try {
    const read = readRules({ home, fs })
    const broken = read.state === 'bad'
    if (broken && onBad !== 'aside') return unwritable(`${file} cannot be used (${read.problem.reason}), so nothing was changed`)
    const before = read.doc
    let after
    try { after = fn(structuredClone(before)) } catch (e) {
      if (!(e instanceof RuleRefused)) throw e
      return { ok: false, before, after: before, written: [], error: { code: e.code, message: e.message } }
    }
    const invalid = checkFile(after)
    if (invalid.length) return { ok: false, before, after, written: [], invalid }
    const bytes = Buffer.from(JSON.stringify(after, null, 2) + '\n') // what is written must read back: the pretty form can be over the size the check cannot see
    const { problem } = parseRulesBytes(bytes)
    if (problem) return { ok: false, before, after, written: [], invalid: [{ path: '', reason: problem.reason }] }
    const planned = { ok: true, before, after, written: [], ...(broken && { kept_delay: read.kept_delay }) }
    if (dryRun) return planned

    const at = now(), written = planned.written
    const moved = `${file}.bad-${at.toISOString().replace(/[:.]/g, '-')}`
    try {
      writeDurable(file, bytes, 0o600, fs, () => {
        if (!holds(fs, lock, token)) throw new Error(`another writer took ${lock}, so nothing was changed`)
        if (broken) { fs.renameSync(file, moved); written.push(moved) }
      })
      written.push(file)
    } catch (e) { return unwritable(e.message, { before, after, written }) }

    const logFile = rulesLog(home)
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
      const row = { ts: at.toISOString(), op, rules: changedRules(before, after), before_sha256: read.sha256, after_sha256: sha256(bytes), source }
      fs.appendFileSync(logFile, JSON.stringify(row) + '\n', { mode: 0o600 })
      written.push(logFile)
    } catch (e) { return { ...planned, log_failed: e.message } }
    return planned
  } finally { dropLock(fs, lock, token) }
}
