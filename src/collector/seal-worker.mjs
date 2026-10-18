// src/collector/seal-worker.mjs — the fork entry of the seal queue (RFC 4.2 §自动封存).
// argv: <segment file> <lock file> [journal]. Exit 0 = sealed (or the file was already gone), 1 = refused or failed,
// with the reason on stderr (the queue turns it into the collector's `failure`; the journal line is written here),
// WORKER_GONE_EXIT = the daemon that owns this queue is gone (not a failure: the next start seals the segment).
import { sealSegment } from '../raw/seal.mjs'
import { WORKER_GONE_EXIT } from './seal-queue.mjs'

process.on('disconnect', () => process.exit(WORKER_GONE_EXIT)) // a sealer MUST NOT outlive the daemon that forked it

const [file, lockFile, journal] = process.argv.slice(2)
await new Promise(setImmediate) // one turn of the loop first: a parent that went while this child was loading is noticed before any file is touched
sealSegment(file, { lockFile, ...(journal ? { journal } : {}) }).then(
  () => process.exit(0),
  (e) => { try { process.stderr.write(String((e && e.message) || e)) } catch { /* stderr gone with the parent */ } process.exit(1) },
)
