// What a stand-in record store must return from envelope(): `{ ok, id }`, the contract of
// src/collector/core/record/store.mjs (D59: the id is `<segment>:<行号>`). The rigs below say
// "written" / "lost" with a boolean, so this is the one place that turns that into the contract.
import fs from 'node:fs'
import path from 'node:path'
import { rawHome } from '../../src/paths.mjs'
import { parseSegment } from '../../src/collector/core/record/segments.mjs'

export const asWritten = (v, line = 1) => (v && typeof v === 'object' ? v : { ok: v !== false, id: `20260101T000000Z:${line}` })

// Where a collector's envelopes are: the raw layer's segments next to its root (D59/D60), not the
// collector's own dated files. Tests that read back what the real store wrote go through here.
// Two places, because a store takes `raw` from the caller: a daemon's root has its raw layer as a
// sibling (~/.asight/raw), while a rig that hands the store one directory writes the segments there.
export const segmentFiles = (collectorDir) => [rawHome(path.dirname(collectorDir)), collectorDir]
  .flatMap((dir) => { try { return fs.readdirSync(dir).filter((n) => parseSegment(n)).map((n) => path.join(dir, n)) } catch { return [] } })
  .sort((a, b) => path.basename(a) < path.basename(b) ? -1 : 1)
export const envelopesOf = (collectorDir) => segmentFiles(collectorDir)
  .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
