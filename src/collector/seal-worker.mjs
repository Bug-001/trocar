// src/collector/seal-worker.mjs — the fork entry of the seal queue (RFC 4.2 §自动封存).
// argv: <segment file> <lock file> [journal ('' = beside the segment)] [normal]. Exit 0 = sealed (or the file was already gone), 1 = refused or failed,
// with the reason on stderr (the queue turns it into the collector's `failure`; the journal line is written here),
// WORKER_GONE_EXIT = the daemon that owns this queue is gone (not a failure: the next start seals the segment).
// After sealing, this child also re-indexes the segment from its sealed copy (D62): the records keep the ids they had,
// but their bytes are addressed by line number instead of by plaintext offset, so the index must be derived again —
// and here, in the low-priority child that already did the encoding, the daemon's event loop never parses a segment.
// LOW PRIORITY is asked for below, on the first line that runs: encoding and hashing a 128 MB segment is the heaviest
// thing trocar ever does, and it MUST NOT take CPU from the agents whose traffic the daemon is forwarding
// (1.6 §3.1 nice ≥ 5). Acceptance on a macOS test machine (2026-10-20) found this child at nice 0: the comment said it, nothing
// did it. The one exception is `normal` (asked for, as a BelowNormal daemon's child inherits BelowNormal): the seal of the last segment when `uninstall` stops the daemon (4.2 §自动封存), when no
// agent traffic goes through trocar any more and the uninstall waits for it. Progress goes to the parent over IPC as {progress:{step, done, total}}.
import os from 'node:os'
import path from 'node:path'
import { sealSegment } from '../raw/seal.mjs'
import { WORKER_GONE_EXIT } from './seal-queue.mjs'
import { parseSegment } from './core/record/segments.mjs'
import { segmentIndex } from '../query/index-build.mjs'
import { lowerPriority } from '../low-priority.mjs'

const [file, lockFile, journal, priority] = process.argv.slice(2)
lowerPriority({ say: (m) => process.stderr.write(`${m}\n`), ...(priority === 'normal' ? { nice: os.constants.priority.PRIORITY_NORMAL } : {}) })

process.on('disconnect', () => process.exit(WORKER_GONE_EXIT)) // a sealer MUST NOT outlive the daemon that forked it
// a progress line reaches the parent before the work goes on (a send still queued is no progress); a parent that is gone is nobody to tell
const say = (progress) => new Promise((resolve) => { try { process.send({ progress }, () => resolve()) } catch { resolve() } })

/** The index of the sealed segment. A failure here costs the next query the build, and that query says so
 *  (`index-cold`, D38) — it is never reported as a seal failure: the bytes are sealed and the index is a cache. */
async function reindex() {
  const seg = parseSegment(path.basename(file))
  if (!seg) return
  try { await segmentIndex({ home: path.dirname(path.dirname(file)), segment: seg.segment, owner: true }) } catch { /* the index is a cache */ }
}

await new Promise(setImmediate) // one turn of the loop first: a parent that went while this child was loading is noticed before any file is touched
// the uninstall stop's seal (`normal`) does not reindex: the index is a projection the next read rebuilds, and nobody is to wait for it (4.2 §自动封存)
sealSegment(file, { lockFile, ...(journal ? { journal } : {}), onProgress: say }).then(
  () => Promise.resolve(priority === 'normal' ? null : say({ step: 'index' }).then(reindex)).then(() => process.exit(0)),
  (e) => { try { process.stderr.write(String((e && e.message) || e)) } catch { /* stderr gone with the parent */ } process.exit(1) },
)
