// Reading records back from a SEALED segment (src/query/records.mjs): whatever the readers share to make a cold fold cheap,
// the answer is the bytes the plaintext held (invariant 2), a file replaced after the read yielded is read anew (never a
// stale fd or frame), and a read that fails says so in `errors` (D38) without poisoning the next one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { recordsAt } from '../../src/query/records.mjs'
import { sealSegment } from '../../src/raw/seal.mjs'

const SEG = '20261018T100000Z'
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `${SEG}:${i + 1}`, segment: SEG, lineNo: i + 1 }))
const json = (recs) => JSON.parse(JSON.stringify(recs))

// a segment whose bodies are big and similar enough to land in several frames and as delta records
function lines(tag, n) {
  return Array.from({ length: n }, (_, i) => envLine({ id: `${tag}-${i}` }).replace('"req_body":"{\\"model\\":\\"m\\"}"',
    `"req_body":${JSON.stringify(JSON.stringify({ model: 'm', tag, messages: Array.from({ length: i + 1 }, (_, k) => ({ role: 'user', content: `${tag} ${k} `.repeat(200) })) }))}`))
}

async function sealedHome(tag, n) {
  const home = rawHome()
  writeSegment(home, SEG, lines(tag, n))
  const plain = json(recordsAt({ home, rows: rowsOf(n), remember: false }))
  await sealSegment(path.join(home, 'raw', `${SEG}.ndjson`), { lockFile: path.join(home, 'collector', 'lock'), journal: null, frameBytes: 64 << 10 })
  const sealed = path.join(home, 'raw', `${SEG}.sealed`)
  assert.ok(fs.existsSync(sealed) && !fs.existsSync(path.join(home, 'raw', `${SEG}.ndjson`)))
  return { home, plain, sealed }
}

test('(a) records read back in several chunks of one tick, and again in a later tick, are the plaintext records', async () => {
  const N = 40
  const { home, plain } = await sealedHome('a', N)
  const rows = rowsOf(N)
  for (let pass = 0; pass < 2; pass++) {
    const errors = [], got = []
    for (let from = 0; from < N; from += 7) got.push(...recordsAt({ home, rows: rows.slice(from, from + 7), errors, remember: false }))
    // out of order and repeated within the same tick too
    const back = recordsAt({ home, rows: [rows[N - 1], rows[0], rows[N - 1]], errors, remember: false })
    assert.deepEqual(errors, [])
    assert.deepEqual(json(got), plain)
    assert.deepEqual(json(back), [plain[N - 1], plain[0], plain[N - 1]])
    await tick()
  }
})

test('(b) a sealed file replaced at the same path after the read yielded is read with its new bytes', async () => {
  const N = 12
  const one = await sealedHome('one', N)
  const two = await sealedHome('two', N)
  assert.notDeepEqual(one.plain, two.plain)
  assert.deepEqual(json(recordsAt({ home: one.home, rows: rowsOf(N), remember: false })), one.plain)
  await tick()
  fs.renameSync(two.sealed, one.sealed)
  assert.deepEqual(json(recordsAt({ home: one.home, rows: rowsOf(N), remember: false })), two.plain)
})

test('(c) a read that fails is reported in errors, and the next read of the same file succeeds', async () => {
  const N = 6
  const { home, plain, sealed } = await sealedHome('c', N)
  const keep = sealed + '.keep'
  assert.deepEqual(json(recordsAt({ home, rows: rowsOf(N), remember: false })), plain) // a reader is open for this file now
  fs.renameSync(sealed, keep)
  fs.writeFileSync(sealed, 'this is not a sealed file')
  const errors = []
  assert.deepEqual(recordsAt({ home, rows: rowsOf(N), errors, remember: false }), [])
  assert.deepEqual(errors.map((e) => e.where), rowsOf(N).map((r) => r.id))
  fs.renameSync(keep, sealed)
  const again = []
  assert.deepEqual(json(recordsAt({ home, rows: rowsOf(N), errors: again, remember: false })), plain)
  assert.deepEqual(again, [])
})

test('4.2 #3 封存往返: the source pointer a record read back mints is the same before and after its segment is sealed', async () => {
  const { rawRefOf } = await import('../../src/view/assemble.mjs')
  const home = rawHome()
  writeSegment(home, SEG, lines('r', 3))
  const before = recordsAt({ home, rows: rowsOf(3), remember: false }).map(rawRefOf)
  await sealSegment(path.join(home, 'raw', `${SEG}.ndjson`), { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  assert.ok(before.every(Boolean))
  assert.deepEqual(recordsAt({ home, rows: rowsOf(3), remember: false }).map(rawRefOf), before, 'a text_ref minted on the plaintext still names the record once sealed')
})

test('(d) a sealed file read again after the read yielded keeps its reader: no fd is open in between, and its index tail is not hashed again', async () => {
  const crypto = await import('node:crypto')
  const N = 12
  const { home, plain, sealed } = await sealedHome('d', N)
  const open = new Map()
  const spy = { ...fs,
    openSync: (...a) => { const fd = fs.openSync(...a); if (a[0] === sealed) open.set(fd, true); return fd },
    closeSync: (fd) => { open.delete(fd); return fs.closeSync(fd) } }
  const update = crypto.Hash.prototype.update
  let hashed = 0
  crypto.Hash.prototype.update = function (d, ...rest) { hashed += Buffer.byteLength(d); return update.call(this, d, ...rest) }
  try {
    const rows = rowsOf(N)
    assert.deepEqual(json(recordsAt({ home, fs: spy, rows: [rows[0]], remember: false })), [plain[0]])
    await tick()
    assert.equal(open.size, 0, 'no fd on the sealed file outlives the read')
    hashed = 0
    assert.deepEqual(json(recordsAt({ home, fs: spy, rows: [rows[N - 1]], remember: false })), [plain[N - 1]])
    // the only bytes hashed are the handed-out line's own sha256 check (4.2 「读」), not the index tail again
    assert.ok(hashed <= Buffer.byteLength(lines('d', N)[N - 1]) + 1, `hashed ${hashed} bytes`)
    await tick()
    assert.equal(open.size, 0, 'no fd on the sealed file outlives the read')
  } finally { crypto.Hash.prototype.update = update }
})
