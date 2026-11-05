// seal.test.mjs — the door password at rest (spec 4.6「日志」, 1.6 :40): a sealed record (the password `***`, `secret:{sha256, fields}`, the door only as
// `door_sha256`) is judged and undone exactly like a clear one. Generated over every json-key and dotenv-block route of every descriptor × darwin / win32;
// the route writers' records are sealed by the manifest save (src/off/manifest.mjs); A1's byte-keeping of the user's fields is checked on a clear record.
// A5 (an unsealed record still undoes): test/collector/core/proxymode/entries.test.mjs 'P5 … CM15 on;off restores the bytes'.
// A6 (the standalone copy builds with seal.mjs): test/off/standalone.test.mjs V11.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { routeEntry, recordsOf } from '../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../src/collector/core/proxymode/sources.mjs'
import { judgeEntry } from '../../src/collector/core/trust/journal.mjs'
import { sealRecord } from '../../src/off/seal.mjs'
import { writtenOf } from '../../src/collector/core/proxymode/status-facts.mjs'
import { redactProxyUrl } from '../../src/netenv/redact.mjs'
import { world, put, bytesOf, door } from '../collector/core/proxymode/fixtures/entries-ctx.mjs'

const harnesses = await loadHarnesses()
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex')
const PW = new URL(door()).password
const USER_PROXY = 'http://user.example:3128'
const MINE = 'http://mine.example:1'
const ROUTES = harnesses.flatMap((h) => Object.entries(h.proxyMode.routes).filter(([, r]) => !r.select && (r.kind === 'json-key' || r.kind === 'dotenv-block')).map(([id, r]) => ({ h, id, r })))
const CASES = ROUTES.flatMap((x) => ['darwin', 'win32'].map((os) => ({ ...x, os })))

// the user's file: an unrelated setting and the user's proxy in the first spelling (so a prior exists)
function userText(r) {
  if (r.kind === 'dotenv-block') return `OPENAI_API_KEY=sk-user-secret\n${r.proxyKeys[0]}=${USER_PROXY}\n`
  const doc = { unrelated: 'keep' }
  let o = doc
  for (const k of r.proxyKeys[0].slice(0, -1)) o = o[k] ??= {}
  o[r.proxyKeys[0].at(-1)] = USER_PROXY
  return JSON.stringify(doc, null, 2) + '\n'
}
// on (the save seals): the world, the route's file, its bytes before and the sealed records
function sealedOn({ h, id, r, os }, { exists = true } = {}) {
  const w = world({ os })
  const ctx = { ...w.ctx, harness: h.name, route: r, routeId: id }
  const file = resolveLoc(r.file, ctx)[0]
  const before = exists ? Buffer.from(userText(r)) : null
  if (before) put(file, before)
  const res = routeEntry(r.kind).write(ctx, door())
  if (!res.ok) return null
  return { w, ctx, file, before, recs: recordsOf(ctx.manifest, h.name, id) }
}

for (const c of CASES) {
  const label = `${c.h.name}.${c.id} (${c.r.kind}) · ${c.os}`

  test(`A1 ${label} — the saved records hold no password, and record its fingerprint and the door's`, () => {
    const s = sealedOn(c)
    for (const x of s.recs) {
      assert.ok(!JSON.stringify(x).includes(PW), 'no password at rest')
      assert.equal(x.door, undefined)
      assert.equal(x.door_sha256, hash(door()))
      assert.equal(x.secret.sha256, hash(PW))
    }
  })

  test(`V70 ${label} — status shows a sealed record's written door like the clear one's, redacted`, () => {
    const s = sealedOn(c)
    const main = s.recs.find((x) => x.door_sha256)
    assert.equal(redactProxyUrl(writtenOf(main)), redactProxyUrl(door()))
    assert.ok(!writtenOf(main).includes(PW))
  })

  test(`A2 ${label} — a sealed record checks, judges intact and undoes to the bytes before, like a clear one`, () => {
    for (const exists of [true, false]) {
      const s = sealedOn(c, { exists })
      if (!s) continue // a route that is not written when its file is absent
      assert.equal(routeEntry(c.r.kind).check(s.ctx, s.recs).ok, true)
      const written = fs.readFileSync(s.file)
      fs.writeFileSync(s.file, Buffer.concat([written, Buffer.from('\n')])) // edited elsewhere: judged by what the file holds, not its hash
      for (const x of s.recs) {
        const planned = { harness: x.harness, kind: x.kind, path: x.path, ...(x.keys ? { keys: x.keys, item: x.item } : { format: x.format, vars: x.vars }) }
        assert.equal(judgeEntry({ manifest: s.ctx.manifest, planned, fs }).action, 'skip-intact')
      }
      fs.writeFileSync(s.file, written)
      assert.ok(!JSON.stringify(s.ctx.manifest).includes(PW), 'the readers unseal a copy: the manifest never gets the password back')
      assert.equal(routeEntry(c.r.kind).undo(s.ctx, s.recs).ok, true)
      assert.deepEqual(bytesOf(s.file), s.before, 'off restores every byte (absent when trocar made the file)')
    }
  })

  test(`A3 ${label} — the user's value set during on survives a sealed undo, and no mask or password is written`, () => {
    const s = sealedOn(c)
    const k = c.r.proxyKeys[0], t = fs.readFileSync(s.file, 'utf8')
    let edited
    if (c.r.kind === 'dotenv-block') { const lines = t.split('\n'); const i = lines.findLastIndex((l) => l.startsWith(`${k}=`)); lines[i] = `${k}=${MINE}`; edited = lines.join('\n') } else {
      const doc = JSON.parse(t); let o = doc; for (const x of k.slice(0, -1)) o = o[x]; o[k.at(-1)] = MINE; edited = JSON.stringify(doc, null, 2) + '\n'
    }
    fs.writeFileSync(s.file, edited)
    const u = routeEntry(c.r.kind).undo(s.ctx, s.recs)
    const after = fs.readFileSync(s.file, 'utf8')
    if (c.r.kind === 'json-key') assert.ok(u.results.some((x) => x.result === 'left-user-value'))
    assert.ok(after.includes(MINE), 'the user\'s value stays')
    assert.ok(!after.includes('***') && !after.includes(PW))
  })

  test(`A4 ${label} — trocar's part deleted by the user: undo writes no mask, the records leave, the user's bytes stay`, () => {
    const s = sealedOn(c)
    const mine = c.r.kind === 'dotenv-block' ? 'OPENAI_API_KEY=sk-user-secret\nLATER=1\n' : '{\n  "unrelated": "kept"\n}\n'
    fs.writeFileSync(s.file, mine)
    routeEntry(c.r.kind).undo(s.ctx, s.recs)
    assert.equal(fs.readFileSync(s.file, 'utf8'), mine)
    assert.deepEqual(recordsOf(s.ctx.manifest, c.h.name, c.id), [])
  })
}

test('A1 sealing masks only the fields trocar wrote: prior_value and ops[].removed keep the user\'s bytes, the password in them included', () => {
  const user = `user-${PW}-own` // a user's string that holds the password as a substring
  const priors = [user, { proxy: user, n: 1 }, [user], null]
  for (const prior_value of priors) {
    const clear = { door: door(), value: door(), vars: { HTTPS_PROXY: door() }, line: `HTTPS_PROXY=${door()}`, prior_value,
      ops: [{ inserted: `"proxy": "${door()}"`, removed: `"proxy": "${user}"` }, { inserted: door(), removed: user }] }
    const x = sealRecord(structuredClone(clear))
    assert.deepEqual(x.prior_value, clear.prior_value)
    assert.deepEqual(x.ops.map((o) => o.removed), clear.ops.map((o) => o.removed))
    for (const w of [x.value, x.vars.HTTPS_PROXY, x.line, ...x.ops.map((o) => o.inserted)]) assert.ok(!w.includes(PW) && w.includes('***'))
    assert.deepEqual(x.secret.fields.map((p) => p.join('.')).sort(), ['line', 'ops.0.inserted', 'ops.1.inserted', 'value', 'vars.HTTPS_PROXY'])
  }
})

test('A1 a PAC door gets a fingerprint and no secret; a password outside the token charset is refused', () => {
  const pac = { door: 'http://127.0.0.1:1/trocar.pac', value: 'http://127.0.0.1:1/trocar.pac' }
  sealRecord(pac)
  assert.equal(pac.door_sha256, hash('http://127.0.0.1:1/trocar.pac'))
  assert.equal(pac.door, undefined)
  assert.equal(pac.secret, undefined)
  assert.throws(() => sealRecord({ door: 'http://g:a@b@127.0.0.1:1', value: 'x' }), TypeError)
})
