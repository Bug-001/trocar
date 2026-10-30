// test/scripts/storage-e7.test.mjs — scripts/storage-e7.mjs, the E7 storage measurement (4.6 E7 7., D71⑤): what one session holds
// on disk against the harness's own session log, read-only over the home it measures.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { rawHome, writeSegment } from '../query/raw-home.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { sealSegment } from '../../src/raw/seal.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/storage-e7.mjs', import.meta.url))
const SEGS = ['20261018T100000Z', '20261018T110000Z']

// every file under `dir`: relative path → size and mtime (a directory too, by its mtime)
function tree(dir, rel = '', out = {}) {
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, ent.name), st = fs.lstatSync(path.join(dir, r))
    out[r] = `${st.size}:${st.mtimeMs}`
    if (ent.isDirectory()) tree(dir, r, out)
  }
  return out
}
const dirBytes = (dir) => Object.entries(tree(dir)).reduce((n, [r, v]) => n + (fs.statSync(path.join(dir, r)).isDirectory() ? 0 : Number(v.split(':')[0])), 0)
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

async function home() {
  const h = rawHome('trocar-e7-')
  // two sessions over two segments, records of uneven size; the first segment sealed, the second plain
  SEGS.forEach((seg, s) => writeSegment(h, seg, Array.from({ length: 12 }, (_, i) => ({
    harness: 'opencode', sessionKey: i % 3 ? 'sess-A' : 'sess-B', ts: `2026-10-18T1${s}:00:${String(i).padStart(2, '0')}.000Z`, id: `req_${s}${i}`,
  })).map((o, i) => ({ ...o, path: '/v1/messages' + '?x'.repeat(i * 40) }))))
  await sealSegment(path.join(h, 'raw', `${SEGS[0]}.ndjson`), { lockFile: path.join(h, 'collector', 'lock'), journal: null })
  for (const segment of SEGS) {
    await segmentIndex({ home: h, segment, owner: true })
    fs.writeFileSync(path.join(h, 'index', `${segment}.usage.json`), 'u'.repeat(1000))
  }
  const ctx = sessionDir(h, 'sess-A')
  fs.mkdirSync(path.join(ctx, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(ctx, 'extract.0.ndjson'), 'e'.repeat(3000))
  fs.writeFileSync(path.join(ctx, 'sub', 'p0.main.ndjson.gz'), 'p'.repeat(700))
  const logs = tmpDir('trocar-e7-log-')
  fs.mkdirSync(path.join(logs, 'subagents'))
  fs.writeFileSync(path.join(logs, 'main.jsonl'), 'l'.repeat(4000))
  fs.writeFileSync(path.join(logs, 'subagents', 'a.jsonl'), 'l'.repeat(2000))
  return { h, ctx, logs }
}

test('E7 measurement: the sessions share the raw bytes, ctx is its dir, ratios and pass flags follow the lines, the home is untouched', async () => {
  const { h, ctx, logs } = await home()
  const before = tree(h)
  const docs = {}
  for (const id of ['sess-A', 'sess-B']) {
    const r = run(['--home', h, '--session', id, '--harness-log', logs])
    assert.equal(r.status, 0, r.stderr)
    docs[id] = JSON.parse(r.stdout)
  }
  assert.deepEqual(tree(h), before)
  const rawFiles = SEGS.map((s, i) => fs.statSync(path.join(h, 'raw', `${s}.${i ? 'ndjson' : 'sealed'}`)).size)
  assert.ok(Math.abs(docs['sess-A'].raw.bytes + docs['sess-B'].raw.bytes - rawFiles[0] - rawFiles[1]) <= SEGS.length)
  assert.ok(docs['sess-A'].raw.bytes > 0 && docs['sess-B'].raw.bytes > 0)
  const a = docs['sess-A']
  assert.equal(a.session, 'sess-A')
  assert.equal(a.ctx.bytes, dirBytes(ctx))
  assert.equal(a.ctx.files, 2)
  assert.equal(a.harness.bytes, 6000)
  assert.equal(a.harness.files, 2)
  assert.equal(a.derived.bytes, a.index.bytes + a.usage.bytes + a.ctx.bytes)
  assert.equal(a.total.bytes, a.raw.bytes + a.derived.bytes)
  assert.equal(a.ratio.total, a.total.bytes / a.harness.bytes)
  assert.equal(a.ratio.derived, a.derived.bytes / a.harness.bytes)
  for (const d of Object.values(docs)) {
    assert.equal(d.pass.total, d.ratio.total <= d.lines.total)
    assert.equal(d.pass.derived, d.ratio.derived <= d.lines.derived)
    assert.deepEqual(d.unindexed, [])
  }
  // a segment without an index is listed, never built
  writeSegment(h, '20261018T120000Z', [{ harness: 'opencode', sessionKey: 'sess-A' }])
  const later = tree(h)
  const r = run(['--home', h, '--session', 'sess-A', '--harness-log', logs])
  assert.deepEqual(JSON.parse(r.stdout).unindexed, ['20261018T120000Z'])
  assert.deepEqual(tree(h), later)
  // without the arguments it measures nothing
  assert.notEqual(run(['--home', h]).status, 0)
})
