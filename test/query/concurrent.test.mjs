// RFC 4.4 #4 (D35): reads running beside the daemon's appends and the seal worker's rename and unlink see every record exactly once,
// none twice, none missing, and say no error for a record that is on disk. Windows is a seam here (a real run is owed on a Windows
// machine): a plaintext another process has open refuses the unlink, or lingers under its name until the last handle closes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import nodeFs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { segmentLines } from '../../src/query/records.mjs'
import { segmentFiles } from '../../src/query/index-build.mjs'
import { sealSegment } from '../../src/raw/seal.mjs'

const CLOSED = '20261018T100000Z', OTHER = '20261018T110000Z', LIVE = '20261018T120000Z', SESSION = 'sess-1'
const WORKER = fileURLToPath(new URL('../../src/collector/seal-worker.mjs', import.meta.url))
const plainOf = (home, seg) => path.join(home, 'raw', `${seg}.ndjson`), sealedOf = (home, seg) => path.join(home, 'raw', `${seg}.sealed`)
const lockOf = (home) => path.join(home, 'collector', 'lock')
const ts = (n) => new Date(Date.parse('2026-10-18T10:00:00.000Z') + n * 1000).toISOString()
const line = (tag, i, repeat = 40) => {
  const o = JSON.parse(envLine({ id: `${tag}-${i}`, ts: ts(i) }))
  o.req_headers['x-claude-code-session-id'] = SESSION
  o.req_body = JSON.stringify({ model: 'm', tag, messages: [{ role: 'user', content: `${tag} ${i} `.repeat(repeat) }] })
  return JSON.stringify(o)
}
const lines = (tag, n) => Array.from({ length: n }, (_, i) => line(tag, i))
const homeWith = (n = 12) => { const home = rawHome('trocar-conc-'); writeSegment(home, CLOSED, lines('a', n)); writeSegment(home, OTHER, lines('b', n)); return home }

// What each of the three ways to read says is there: `sessions` as a count, `session` by id, `block` and `raw` by bytes.
const askRead = (fs) => async (name, params, home) => runQuery(name, params, { home, ...(fs ? { fs } : {}) })
async function readAll(home, { fs = null, want } = {}) {
  const ask = askRead(fs), errors = []
  const list = await ask('sessions', { limit: '500' }, home); errors.push(...list.errors)
  const one = await ask('session', { id: SESSION }, home); errors.push(...(one.errors || []))
  const rids = (one.calls || []).map((c) => String(c.rid))
  const raw = []
  for (const [segment] of segmentFiles(home, fs || nodeFs, errors)) for (const [no] of segmentLines({ home, segment, ...(fs ? { fs } : {}) })) raw.push(`${segment}:${no}`)
  const blocks = []
  for (const ref of want) { const b = await ask('block', { ref }, home); errors.push(...(b.errors || [])); blocks.push(...(b.blocks || []).filter((x) => x.bytes != null).map(() => ref)) }
  return { calls: list.sessions.find((s) => s.session_id === SESSION)?.calls ?? 0, rids, raw, blocks, errors }
}
const idsOf = (segs) => segs.flatMap(([seg, n]) => Array.from({ length: n }, (_, i) => `${seg}:${i + 1}`))
function assertOnce(got, want, at) {
  assert.deepEqual(got.errors, [], `${at}: no error for a record on disk`)
  assert.equal(got.calls, want.length, `${at}: sessions counts each once`)
  for (const k of ['rids', 'raw', 'blocks']) assert.deepEqual([...got[k]].sort(), [...want].sort(), `${at}: ${k}`)
}

test('at every step of a seal, warm and cold, each read sees every record exactly once', async () => {
  for (const warm of [false, true]) {
    for (const stop of ['verified', 'renamed', 'deleted']) {
      const at = `${stop}/${warm ? 'warm' : 'cold'}`, home = homeWith(), want = idsOf([[CLOSED, 12], [OTHER, 12]])
      if (warm) assertOnce(await readAll(home, { want }), want, `${at}: before`)
      await sealSegment(plainOf(home, CLOSED), { lockFile: lockOf(home), journal: null, onPhase: async (p) => { if (p === stop) assertOnce(await readAll(home, { want }), want, at) } })
      assertOnce(await readAll(home, { want }), want, `${at}: after`)
    }
  }
})

// The name is there when a reader looks and gone when it opens. `code`: ENOENT on POSIX, EPERM where Windows has the delete pending.
function vanishes(home, seg, code) {
  const plain = plainOf(home, seg)
  let armed = false, gone = false
  const refuse = (name, f) => (p, ...a) => {
    if (String(p) === plain) {
      if (armed && !gone) { gone = true; nodeFs.unlinkSync(plain) }
      if (gone) throw Object.assign(new Error(`${code}: ${name} '${p}'`), { code })
    }
    return f(p, ...a)
  }
  const fs = new Proxy(nodeFs, { get: (t, k) => (k === 'openSync' || k === 'readFileSync' ? refuse(k, t[k].bind(t)) : t[k]) })
  return { fs, arm: () => { armed = true; gone = false }, wentAway: () => gone }
}
const sealedBeside = async (home, seg) => { // the two files of the window after the rename, the plaintext still there
  const plain = plainOf(home, seg), bytes = nodeFs.readFileSync(plain)
  await sealSegment(plain, { lockFile: lockOf(home), journal: null })
  nodeFs.writeFileSync(plain, bytes, { mode: 0o600 })
}

for (const code of ['ENOENT', 'EPERM']) {
  test(`a plaintext unlinked between a reader's look and its open (${code}): the sealed copy answers, and no record is missing`, async () => {
    const reads = {
      raw: async (v, home) => { v.arm(); return [...segmentLines({ home, segment: CLOSED, fs: v.fs })].length },
      block: async (v, home) => { v.arm(); return (await runQuery('block', { ref: `${CLOSED}:3` }, { home, fs: v.fs })) },
      session: async (v, home) => { await runQuery('sessions', { limit: '500' }, { home, fs: v.fs }); v.arm(); return (await runQuery('session', { id: SESSION }, { home, fs: v.fs })) },
    }
    for (const [name, read] of Object.entries(reads)) {
      const home = homeWith()
      await sealedBeside(home, CLOSED)
      const v = vanishes(home, CLOSED, code), got = await read(v, home)
      assert.ok(v.wentAway(), `${name}: the window was exercised`)
      if (name === 'raw') assert.equal(got, 12)
      if (name === 'block') { assert.deepEqual(got.errors, [], name); assert.equal(got.blocks?.length, 1, name); assert.ok(got.blocks[0].bytes, name) }
      if (name === 'session') { assert.deepEqual(got.errors, [], name); assert.equal(new Set(got.calls.map((c) => c.rid)).size, 24, name) }
    }
  })
}

// Windows: an unlink while a reader has the file open is refused; the plaintext stays and wins, and a later seal finishes it.
for (const code of ['EBUSY', 'EPERM']) {
  test(`an unlink refused while a reader has the plaintext open (${code}): nothing is lost, the reads stay whole, and the next seal finishes`, async () => {
    const home = homeWith(), want = idsOf([[CLOSED, 12], [OTHER, 12]]), plain = plainOf(home, CLOSED)
    const refusing = new Proxy(nodeFs, { get: (t, k) => (k === 'unlinkSync' ? (p) => { if (String(p) === plain) throw Object.assign(new Error(`${code}: unlink '${p}'`), { code }); return t.unlinkSync(p) } : t[k]) })
    await assert.rejects(sealSegment(plain, { lockFile: lockOf(home), journal: null, fs: refusing }), /the plaintext is kept/)
    assert.ok(nodeFs.existsSync(plain) && nodeFs.existsSync(sealedOf(home, CLOSED)), 'both files')
    assertOnce(await readAll(home, { want }), want, 'both files')
    await sealSegment(plain, { lockFile: lockOf(home), journal: null })
    assert.equal(nodeFs.existsSync(plain), false)
    assertOnce(await readAll(home, { want }), want, 'sealed')
  })
}

// Windows: the unlink succeeded while another handle is open. The name stays listed until that handle closes, and every look at it is refused.
test('a plaintext whose delete is pending: listed, unopenable, and the sealed copy answers', async () => {
  const home = homeWith(), want = idsOf([[CLOSED, 12], [OTHER, 12]]), plain = plainOf(home, CLOSED)
  await sealSegment(plain, { lockFile: lockOf(home), journal: null })
  const denied = (p) => { throw Object.assign(new Error(`EPERM: operation not permitted '${p}'`), { code: 'EPERM' }) }
  const pending = new Proxy(nodeFs, { get: (t, k) => {
    if (k === 'readdirSync') return (d, ...a) => { const names = t.readdirSync(d, ...a); return String(d) === path.dirname(plain) ? [...names, path.basename(plain)] : names }
    if (k === 'existsSync') return (p) => (String(p) === plain ? false : t.existsSync(p))
    if (['statSync', 'lstatSync', 'openSync', 'readFileSync'].includes(k)) return (p, ...a) => (String(p) === plain ? denied(p) : t[k](p, ...a))
    return t[k]
  } })
  assertOnce(await readAll(home, { fs: pending, want }), want, 'delete pending')
})

test('a plaintext that is there and cannot be opened still wins: the read says so, and the sealed copy is not read instead', async () => {
  const home = homeWith(); await sealedBeside(home, CLOSED)
  const plain = plainOf(home, CLOSED), denied = (p) => { throw Object.assign(new Error(`EACCES: '${p}'`), { code: 'EACCES' }) }
  const fs = new Proxy(nodeFs, { get: (t, k) => (k === 'openSync' || k === 'readFileSync' ? (p, ...a) => (String(p) === plain ? denied(p) : t[k](p, ...a)) : t[k]) })
  const b = await runQuery('block', { ref: `${CLOSED}:3` }, { home, fs })
  assert.notDeepEqual(b.errors, [], 'said')
  assert.throws(() => [...segmentLines({ home, segment: CLOSED, fs })], /EACCES/)
})

test('beside the daemon\'s appends: a half line is not a record until its newline, and a read sees what was complete when it began', async () => {
  const home = rawHome('trocar-conc-'), file = plainOf(home, LIVE)
  nodeFs.writeFileSync(file, '', { mode: 0o600 })
  let n = 0
  for (const cut of [0, 7, 200]) {
    for (let k = 0; k < 3; k++) { nodeFs.appendFileSync(file, `${line('c', n)}\n`); n++ }
    const l = line('c', n)
    if (cut) nodeFs.appendFileSync(file, l.slice(0, cut))
    const want = idsOf([[LIVE, n]]), got = await readAll(home, { want })
    assert.deepEqual(got.errors, [], `cut ${cut}`)
    assert.equal(got.calls, n, `cut ${cut}: sessions`)
    assert.deepEqual([...got.rids].sort(), [...want].sort(), `cut ${cut}: session`)
    if (cut) nodeFs.appendFileSync(file, `${l.slice(cut)}\n`), n++
  }
})

test('real processes: seal workers run while the daemon appends and reads loop, and no read sees a record twice or misses one it could see', async () => {
  const home = rawHome('trocar-conc-'), big = (tag, i) => line(tag, i, 800)
  const segs = ['20261018T100000Z', '20261018T101000Z', '20261018T102000Z', '20261018T103000Z'], N = 150
  for (const [k, s] of segs.entries()) writeSegment(home, s, Array.from({ length: N }, (_, i) => big(`s${k}`, i)))
  nodeFs.mkdirSync(path.dirname(lockOf(home)), { recursive: true })
  nodeFs.writeFileSync(plainOf(home, LIVE), '', { mode: 0o600 })
  nodeFs.writeFileSync(lockOf(home), JSON.stringify({ pid: process.pid, segment: LIVE, at: Date.now() }))
  const closed = segs.map((s) => [s, N])
  let written = 0, done = false
  const appender = (async () => { while (!done) { nodeFs.appendFileSync(plainOf(home, LIVE), `${line('live', written)}\n`); written++; await sleep(2) } })()
  const failures = []
  const worker = (s) => new Promise((resolve) => {
    const c = fork(WORKER, [plainOf(home, s), lockOf(home), path.join(home, 'raw', 'journal.jsonl')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, NODE_OPTIONS: '' } })
    let err = ''; c.stderr.on('data', (d) => { err += d })
    c.on('exit', (code) => { if (code !== 0) failures.push(`${s}: ${code} ${err}`); resolve() })
  })
  const sealing = (async () => { for (const s of segs) await worker(s); done = true })()
  let reads = 0, sawSealed = 0
  while (!done || reads < 2) {
    const before = written, ask = askRead(null)
    const one = await ask('session', { id: SESSION }, home), rids = one.calls.map((c) => String(c.rid)), after = written
    assert.deepEqual(one.errors ?? [], [], `read ${reads}`)
    assert.equal(new Set(rids).size, rids.length, `read ${reads}: none twice`)
    const inLive = rids.filter((r) => r.startsWith(`${LIVE}:`)).length
    assert.deepEqual(rids.filter((r) => !r.startsWith(`${LIVE}:`)).sort(), idsOf(closed).sort(), `read ${reads}: every closed record`)
    assert.ok(inLive >= before && inLive <= after, `read ${reads}: ${inLive} of the live segment, ${before}..${after} written`)
    if (segs.some((s) => nodeFs.existsSync(sealedOf(home, s)))) sawSealed++
    reads++
    await sleep(0)
  }
  await sealing; await appender
  assert.deepEqual(failures, [])
  for (const s of segs) assert.ok(nodeFs.existsSync(sealedOf(home, s)) && !nodeFs.existsSync(plainOf(home, s)), `${s} sealed`)
  assert.ok(sawSealed > 0 && reads > 2, `reads overlapped the seals: ${reads} reads`)
})
