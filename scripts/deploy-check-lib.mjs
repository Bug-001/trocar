// scripts/deploy-check-lib.mjs — what decides scripts/deploy-check.mjs's exit code (RFC 4.4 #19), apart so a test can run it on made-up
// directories. It reads this copy's src: the check imports it from the code it runs, so a version it asks about is that code's.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseSegment } from '../src/collector/core/record/segments.mjs'
import { projectionStale } from '../src/query/projection.mjs'
import { foldStale } from '../src/query/fold-log.mjs'
import { hasReread } from '../src/query/ctx-files.mjs'

/** `from` copied to `to`, every link followed: a copy-on-write clone where the disk has one. */
export const clone = (from, to) => { try { execFileSync('cp', ['-cRL', from, to], { stdio: 'ignore' }) } catch { fs.cpSync(from, to, { recursive: true, dereference: true }) } }

export const p95 = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : null }

/** The segments of a raw/ as {name, size, mtimeMs}: anything else there (the journal, a sealer's temp) is the daemon's own to change. */
export function rawList(dir) {
  const out = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!parseSegment(name)) continue
    try { const st = fs.statSync(path.join(dir, name)); out.push({ name, size: st.size, mtimeMs: st.mtimeMs }) } catch { /* sealed away between the two calls */ }
  }
  return out
}

/** What became of the segments `before` listed, in `after`: a sealed one is what it was; an open one has only grown, or is sealed under its own
 *  name. A segment `after` adds is the live daemon's rollover. → {ok, refused: [{file, was, now}]} (`now` null: it is gone). */
export function rawDiff(before, after) {
  const now = new Map(after.map((f) => [f.name, f])), refused = []
  for (const f of before) {
    const { segment, sealed } = parseSegment(f.name), got = now.get(f.name) ?? null
    if (sealed ? got && got.size === f.size && got.mtimeMs === f.mtimeMs : got ? got.size >= f.size : now.has(`${segment}.sealed`)) continue
    refused.push({ file: f.name, was: f, now: got })
  }
  return { ok: !refused.length, refused }
}

const bare = (name) => parseSegment(name)?.segment ?? name
/** Each segment of raw (rawList's) against the row list's runs of one segment, {segment, rows}, oldest first. A segment holds the same records
 *  plain and sealed, so the rows may name either form. Nothing to lose in an empty file. → {ok, lost: [segment], twice: [segment]} */
export function segmentCheck(rawSegments, indexRowsBySegment) {
  const rows = new Map(), twice = []
  for (const r of indexRowsBySegment) {
    const k = bare(r.segment)
    if (rows.has(k) && !twice.includes(k)) twice.push(k)
    rows.set(k, (rows.get(k) ?? 0) + r.rows)
  }
  const lost = rawSegments.filter((f) => f.size > 0 && !rows.get(bare(f.name))).map((f) => bare(f.name))
  return { ok: !lost.length && !twice.length, lost, twice }
}

/** The ids among `ids` whose re-read has not ended: a `reread` marker, or a projection or fold log of another version (the worker's own
 *  test, 3.5 §访问模式「版本变更的重读」). */
export const rereading = (home, ids) => ids.filter((key) => hasReread(home, key) || projectionStale({ home, key }) || foldStale({ home, key }))

/** The page's requests by path: what reached the worker, and the answer files `/api/d/*`, which do not (4.4 §答案文件). */
export function requestsByPath(requests) {
  const out = { worker: {}, files: {} }
  for (const { url } of requests) {
    const p = url.split('?')[0], side = p.startsWith('/api/d/') ? out.files : out.worker, k = p.replace(/\/p\d+.*/, '/p*')
    side[k] = (side[k] || 0) + 1
  }
  return out
}

const sh = (p) => `'${p.replace(/'/g, "'\\''")}'`
/** The swap of a pre-read (D78 ④) as a shell script for the operator to run, never this check: `side` takes the place of `real`'s index,
 *  which stays beside it under `before`, only with the daemon stopped. */
export function preRead({ real, side, before }) {
  const lock = path.join(real, 'collector', 'lock'), index = path.join(real, 'index'), old = path.join(real, before)
  return `sh -e <<'SWAP'
test ! -e ${sh(lock)} || { echo 'the daemon is running: stop it first' >&2; exit 1; }
test ! -e ${sh(old)} || { echo 'an earlier index is still kept there' >&2; exit 1; }
mv ${sh(index)} ${sh(old)}
mv ${sh(side)} ${sh(index)}
SWAP`
}

/** `lines`: name → a number, the most `measured[name]` may be, or {idle, times, plusMs}, the most being measured[idle] * times + plusMs.
 *  A value not measured fails: a line nothing was read against has not held. → {pass, failures}: `failures` and each line that did not hold. */
export function verdict(lines, measured, failures) {
  const out = [...failures], known = (v) => typeof v === 'number' && Number.isFinite(v)
  for (const [name, line] of Object.entries(lines)) {
    const got = measured[name], idle = typeof line === 'number' ? 0 : measured[line.idle]
    const most = typeof line === 'number' ? line : idle * line.times + line.plusMs
    if (!known(got) || !known(idle)) out.push(`${name}: not measured`)
    else if (got > most) out.push(`${name}: ${got} ms is over ${most} ms`)
  }
  return { pass: !out.length, failures: out }
}
