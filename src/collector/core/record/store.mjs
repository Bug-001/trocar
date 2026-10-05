// store.mjs — the collector's append-only record store (RFC 4.6 §记录). Envelopes go to the
// top-level capture-<date>.ndjson the board reads; transparent/spliced flows, audit and replays go
// to subdirectories so the board never mistakes them for envelopes. Directories are 0700, files
// 0600 (they hold verbatim credentials). Recording MUST NEVER throw into the forwarding path: every
// write is wrapped, failures are counted and reported via onError, never rethrown.
import fs from 'node:fs'
import path from 'node:path'

export function createRecordStore({ root, onError = () => {} }) {
  const fds = new Map() // filePath → open fd
  let errors = 0

  const dateOf = (rec) => String(rec && rec.ts ? rec.ts : new Date().toISOString()).slice(0, 10) // YYYY-MM-DD (UTC)

  function fdFor(filePath) {
    let fd = fds.get(filePath)
    if (fd !== undefined) return fd
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    fd = fs.openSync(filePath, 'a', 0o600)
    try { fs.fchmodSync(fd, 0o600) } catch { /* some filesystems refuse chmod */ }
    fds.set(filePath, fd)
    return fd
  }

  function write(resolve, rec) {
    try {
      fs.writeSync(fdFor(resolve(dateOf(rec))), JSON.stringify(rec) + '\n')
    } catch (e) {
      errors++
      onError(e)
    }
  }

  return {
    envelope(env) { write((d) => path.join(root, `capture-${d}.ndjson`), env) },
    flow(rec) { write((d) => path.join(root, 'flows', `${d}.ndjson`), rec) },
    audit(rec) { write((d) => path.join(root, 'audit', `${d}.ndjson`), rec) },
    replay(env) { write((d) => path.join(root, 'replays', `${d}.ndjson`), env) },
    get errors() { return errors },
    close() { for (const fd of fds.values()) { try { fs.closeSync(fd) } catch { /* already closed */ } } fds.clear() },
  }
}
