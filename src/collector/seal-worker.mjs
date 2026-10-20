// src/collector/seal-worker.mjs — the fork entry of the seal queue (RFC 4.2 §自动封存).
// argv: <segment file> <lock file> [journal]. Exit 0 = sealed (or the file was already gone), 1 = refused or failed,
// with the reason on stderr (the queue turns it into the collector's `failure`; the journal line is written here),
// WORKER_GONE_EXIT = the daemon that owns this queue is gone (not a failure: the next start seals the segment).
// After sealing, this child also re-indexes the segment from its sealed copy (D62): the records keep the ids they had,
// but their bytes are addressed by line number instead of by plaintext offset, so the index must be derived again —
// and here, in the low-priority child that already did the encoding, the daemon's event loop never parses a segment.
// LOW PRIORITY is asked for below, on the first line that runs: encoding and hashing a 128 MB segment is the heaviest
// thing trocar ever does, and it MUST NOT take CPU from the agents whose traffic the daemon is forwarding
// (1.6 §3.1 nice ≥ 5). Acceptance on a macOS test machine (2026-10-20) found this child at nice 0: the comment said it, nothing
// did it.
import path from 'node:path'
import { sealSegment } from '../raw/seal.mjs'
import { WORKER_GONE_EXIT } from './seal-queue.mjs'
import { parseSegment } from './core/record/segments.mjs'
import { segmentIndex } from '../query/index-build.mjs'
import { lowerPriority } from '../low-priority.mjs'

lowerPriority({ say: (m) => process.stderr.write(`${m}\n`) })

process.on('disconnect', () => process.exit(WORKER_GONE_EXIT)) // a sealer MUST NOT outlive the daemon that forked it

const [file, lockFile, journal] = process.argv.slice(2)

/** The index of the sealed segment. A failure here costs the next query the build, and that query says so
 *  (`index-cold`, D38) — it is never reported as a seal failure: the bytes are sealed and the index is a cache. */
async function reindex() {
  const seg = parseSegment(path.basename(file))
  if (!seg) return
  try { await segmentIndex({ home: path.dirname(path.dirname(file)), segment: seg.segment, owner: true }) } catch { /* the index is a cache */ }
}

await new Promise(setImmediate) // one turn of the loop first: a parent that went while this child was loading is noticed before any file is touched
sealSegment(file, { lockFile, ...(journal ? { journal } : {}) }).then(
  () => reindex().then(() => process.exit(0)),
  (e) => { try { process.stderr.write(String((e && e.message) || e)) } catch { /* stderr gone with the parent */ } process.exit(1) },
)
