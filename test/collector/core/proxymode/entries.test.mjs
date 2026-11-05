// entries.test.mjs — the P5 route writers, generated over every descriptor route × the axes of spec 4.11 CM15–CM17 (plan T16): file present / absent ×
// the route's `absent`; the user's proxy in no, one or both spellings; the user's NO_PROXY plus the persistent env; LF / CRLF; UTF-8, UTF-8 with a mark,
// UTF-16 with a mark (test/helpers/file-shapes.mjs); the user editing each key during on. `select` and `arrayItems` routes: entries-select.test.mjs;
// present / blockers (CM31): entries-forms.test.mjs. Seeds: test/collector/arch/{darwin,win32}/entries.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { routeEntry, recordsOf } from '../../../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { backupDir } from '../../../../src/off/paths.mjs'
import { sha256 } from '../../../../src/off/fsutil.mjs'
import { encodeText, decodeBytes } from '../../../helpers/file-shapes.mjs'
import { world, put, bytesOf, door, merged } from './fixtures/entries-ctx.mjs'

const harnesses = await loadHarnesses()
const USER_PROXY = 'http://user.example:3128'
const USER_NO = '*.corp.example,LOCALHOST'
const PERSIST = { NO_PROXY: '.internal,127.0.0.1' }
const ENCODINGS = [['utf8', false], ['utf8', true], ['utf16le', true]]
const EOLS = { lf: '\n', crlf: '\r\n' }
const CERT_KINDS = new Set(['root-key', 'system-root'])

// the user's file as the generator shapes it: one unrelated setting (an API key in a .env: it must never move), the user's proxy, the user's NO_PROXY
function userText(route, { spell, noProxy, eol, proxy: userProxy = USER_PROXY }) {
  const proxy = (route.proxyKeys || []).slice(0, spell)
  if (route.kind === 'dotenv-block') {
    const lines = ['OPENAI_API_KEY=sk-user-secret', ...proxy.map((k) => `${k}=${userProxy}`), ...(noProxy && route.noProxyKeys ? [`${route.noProxyKeys[0]}=${USER_NO}`] : [])]
    return lines.join(eol) + eol
  }
  const doc = { unrelated: 'keep' }
  const set = (keys, v) => { let o = doc; for (const k of keys.slice(0, -1)) o = o[k] ??= {}; o[keys.at(-1)] = v }
  for (const k of proxy) set(k, userProxy)
  if (noProxy && route.noProxyKeys) set(route.noProxyKeys[0], USER_NO)
  return JSON.stringify(doc, null, 2).replace(/\n/g, eol) + eol
}
const dotenvValue = (text, k) => { let v; for (const l of text.split(/\r?\n/)) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l.replace(/^\uFEFF/, '')); if (m && m[1] === k) v = m[2] } return v }
const jsonValue = (text, keys) => keys.reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(text.replace(/^\uFEFF/, '')))
const valueIn = (route, text, k) => (route.kind === 'dotenv-block' ? dotenvValue(text, k) : jsonValue(text, k))
const textOf = (f) => { const b = bytesOf(f); return b == null ? null : decodeBytes(b).text }
const ctxFor = (w, h, id) => ({ ...w.ctx, harness: h.name, route: h.proxyMode.routes[id], routeId: id })

const ROUTES = harnesses.flatMap((h) => Object.entries(h.proxyMode.routes).filter(([, r]) => !r.select).map(([id, r]) => ({ h, id, r })))

for (const { h, id, r } of ROUTES.filter((x) => x.r.kind === 'json-key' || x.r.kind === 'dotenv-block')) for (const os of ['darwin', 'win32']) for (const exists of [true, false]) {
  test(`P5 ${h.name}.${id} (${r.kind}) · ${os} · file ${exists ? 'present' : 'absent'} (absent: ${r.absent}) — CM15 on;off restores the bytes, CM16 both spellings + NO_PROXY merge, CM17 block after the user's lines`, () => {
    // pairwise: every encoding × line ending meets the value axes in turn, and every value combination is met (the full cross product adds no case)
    const forms = ENCODINGS.flatMap((enc) => Object.keys(EOLS).map((eol) => ({ enc, eol })))
    const values = [0, 1, 2].filter((n) => n <= (r.proxyKeys || []).length).flatMap((spell) => [false, true].map((noProxy) => ({ spell, noProxy })))
    const shapes = exists ? Array.from({ length: Math.max(forms.length, values.length) }, (_, i) => ({ ...forms[i % forms.length], ...values[i % values.length] })) : [{ eol: 'lf', spell: 0, noProxy: false }]
    for (const s of shapes) {
      const label = JSON.stringify(s)
      const w = world({ os, persistent: PERSIST })
      const ctx = ctxFor(w, h, id)
      const file = resolveLoc(r.file, ctx)[0]
      const original = exists ? userText(r, { ...s, eol: EOLS[s.eol] }) : null
      const before = exists ? encodeText(original, s.enc[0], s.enc[1]) : null
      if (before) put(file, before)
      const ca = path.join(w.home, 'certs', 'ca.pem'); put(ca, '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n')
      const res = routeEntry(r.kind).write(ctx, door())
      if (!exists && r.absent === 'not-routed') {
        assert.deepEqual([res.code, res.reason, res.at, bytesOf(file), w.ctx.manifest.entries.length], ['not-routed', 'absent', file, null, 0], `${label}: nothing written, the reason given`)
        continue
      }
      assert.equal(res.ok, true, label)
      const now = textOf(file)
      for (const k of r.proxyKeys) assert.equal(valueIn(r, now, k), door(), `${label}: ${k} is the door (every spelling)`)
      for (const k of r.noProxyKeys || []) assert.equal(valueIn(r, now, k), merged(s.noProxy ? USER_NO : '', PERSIST.NO_PROXY), `${label}: ${k} = loopback ∪ the user's ∪ the persistent env, case-insensitive, in order`)
      const recs = recordsOf(w.ctx.manifest, h.name, id)
      assert.ok(recs.length > 0 && recs.every((x) => x.phase === 'on' && x.route === id && !CERT_KINDS.has(x.kind)), label)
      if (r.kind === 'dotenv-block') {
        assert.ok(now.startsWith(original ?? ''), `${label}: CM17 the user's lines stay first, byte for byte; nothing is commented out`)
        if (s.spell) assert.equal(recs[0].prior_value[r.proxyKeys[0]], USER_PROXY, `${label}: CM17 the user's value is the prior`)
      } else if (s.spell) assert.equal(recs.find((x) => JSON.stringify(x.keys) === JSON.stringify(r.proxyKeys[0])).prior_value, USER_PROXY, `${label}: the replaced value is the prior`)
      assert.equal(routeEntry(r.kind).check(ctx, recs).ok, true, label)
      assert.equal(routeEntry(r.kind).write(ctx, door()).ok, true, `${label}: on again`)
      assert.equal(recordsOf(w.ctx.manifest, h.name, id).length, recs.length, `${label}: on again writes nothing more (R9)`)
      const u = routeEntry(r.kind).undo(ctx, recs)
      assert.equal(u.ok, true, label)
      assert.deepEqual(bytesOf(file), before, `${label}: CM15 off restores every byte (the file is gone again when trocar made it)`)
      assert.equal(fs.readFileSync(ca, 'utf8'), '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n', `${label}: CM15 no certificate bytes touched`)
      assert.deepEqual(recordsOf(w.ctx.manifest, h.name, id), [], `${label}: the undone records leave the manifest`)
    }
  })
}

// P5: a value left in the file that is one of trocar's doors (a loopback URL on a port ingress.json records; the manifest that wrote it lost) is not the
// user's prior — on records none for it and off leaves no door behind; a loopback proxy of the user's on another port is their prior as any other
for (const { h, id, r } of ROUTES.filter((x) => x.r.kind === 'json-key' || x.r.kind === 'dotenv-block')) {
  test(`P5 ${h.name}.${id} (${r.kind}) — a door value already in the file is not the prior; off leaves no door; the user's own loopback proxy is the prior`, () => {
    const OLD = 'http://g:ffffffffffffffffffffffffffffffff@127.0.0.1:18001'
    for (const [proxy, isDoor] of [[OLD, true], [door(), true], ['http://127.0.0.1:7890', false]]) {
      const w = world()
      put(path.join(w.dir, 'ingress.json'), JSON.stringify({ groupPorts: { [`${h.name}:a`]: 18001, [`${h.name}:b`]: 18003 } }))
      const ctx = ctxFor(w, h, id)
      const file = resolveLoc(r.file, ctx)[0]
      const before = Buffer.from(userText(r, { spell: (r.proxyKeys || []).length, noProxy: false, eol: '\n', proxy }))
      put(file, before)
      const res = routeEntry(r.kind).write(ctx, door())
      assert.equal(res.ok, true, proxy)
      for (const k of r.proxyKeys) assert.equal(valueIn(r, textOf(file), k), door(), `${proxy}: ${k} is the door`)
      const priors = JSON.stringify(res.records.map((x) => x.prior_value))
      if (isDoor) assert.ok(!priors.includes('127.0.0.1:18001'), `${proxy}: a door is never recorded as the user's prior (${priors})`)
      else assert.ok(priors.includes(proxy), `${proxy}: the user's loopback proxy on another port is the prior`)
      // 4.6「日志」· V106: one write, one backup, named by the manifest, holding no door password
      const bk = backupDir(w.home), saved = fs.readdirSync(bk).map((n) => path.join(bk, n))
      assert.deepEqual(saved, [res.records[0].backup], `${proxy}: one backup of the file, the one the manifest names`)
      const kept = fs.readFileSync(saved[0])
      assert.equal(sha256(kept), res.records[0].pre_sha256, `${proxy}: the backup is what the manifest records the file was before its one write`)
      if (isDoor) assert.ok(!/127\.0\.0\.1:18001|f{32}|0123456789abcdef0123456789abcdef/.test(kept.toString('latin1')), `${proxy}: no door URL or token in the backup`)
      else assert.deepEqual(kept, before, `${proxy}: the backup is the bytes before on`)
      assert.equal(routeEntry(r.kind).undo(ctx, res.records).ok, true, proxy)
      const after = textOf(file)
      if (isDoor) {
        assert.ok(after != null && !after.includes('127.0.0.1:18001'), `${proxy}: off leaves no door value in the file`)
        assert.ok(after.includes(r.kind === 'dotenv-block' ? 'OPENAI_API_KEY=sk-user-secret' : '"unrelated": "keep"'), `${proxy}: the user's other settings stay`)
      } else assert.deepEqual(bytesOf(file), before, `${proxy}: off restores every byte`)
    }
  })
}

for (const { h, id, r } of ROUTES.filter((x) => x.r.kind === 'json-key' || x.r.kind === 'dotenv-block')) for (const eol of Object.keys(EOLS)) {
  test(`P5 ${h.name}.${id} · ${eol} — the user's edit of each key during on survives off (D48②); the other keys go back to their priors`, () => {
    const keys = [...r.proxyKeys, ...(r.noProxyKeys || [])]
    for (const edited of keys) {
      const w = world({ persistent: PERSIST })
      const ctx = ctxFor(w, h, id)
      const file = resolveLoc(r.file, ctx)[0]
      const original = userText(r, { spell: 1, noProxy: true, eol: EOLS[eol] })
      put(file, original)
      const recs = routeEntry(r.kind).write(ctx, door()).records
      const t = fs.readFileSync(file, 'utf8')
      const leaf = r.kind === 'dotenv-block' ? edited : edited.at(-1)
      const mine = 'http://mine.example:1'
      const re = r.kind === 'dotenv-block' ? new RegExp(`^${leaf}=.*$`, 'm') : new RegExp(`"${leaf.replace(/\./g, '\\.')}": "[^"]*"`)
      const [hit] = [...t.matchAll(new RegExp(re.source, re.flags.includes('m') ? 'gm' : 'g'))].slice(-1)
      fs.writeFileSync(file, t.slice(0, hit.index) + (r.kind === 'dotenv-block' ? `${leaf}=${mine}` : `"${leaf}": "${mine}"`) + t.slice(hit.index + hit[0].length))
      routeEntry(r.kind).undo(ctx, recs)
      const after = fs.readFileSync(file, 'utf8')
      assert.equal(valueIn(r, after, edited), mine, `${JSON.stringify(edited)}: the user's value stays`)
      for (const k of keys.filter((x) => x !== edited)) assert.equal(valueIn(r, after, k), valueIn(r, original, k), `${JSON.stringify(edited)} edited: ${JSON.stringify(k)} is back to the user's prior`)
      if (r.kind === 'dotenv-block') assert.equal(dotenvValue(after, 'OPENAI_API_KEY'), 'sk-user-secret')
    }
  })
}

for (const { h, id, r } of ROUTES.filter((x) => x.r.kind === 'plugin-file' || x.r.kind === 'switch-file')) for (const os of ['darwin', 'win32']) {
  test(`P5 ${h.name}.${id} (${r.kind}) · ${os} — an owned file holding the door (0600 for the switch), on again is a no-op, off removes it and the directories it made`, () => {
    const w = world({ os })
    const ctx = ctxFor(w, h, id)
    const res = routeEntry(r.kind).write(ctx, door())
    assert.equal(res.ok, true)
    const [rec] = res.records
    assert.deepEqual([rec.kind, rec.role, rec.phase, rec.route], ['owned-file', r.kind === 'switch-file' ? 'switch' : 'plugin', 'on', id])
    if (r.kind === 'switch-file') {
      assert.equal(rec.path, path.join(w.dir, 'switch', h.name))
      assert.equal(fs.readFileSync(rec.path, 'utf8'), door())
      if (process.platform !== 'win32') assert.equal(fs.statSync(rec.path).mode & 0o777, 0o600)
    } else {
      assert.equal(path.dirname(rec.path), resolveLoc(r.dir, ctx)[0])
      assert.equal(fs.readFileSync(rec.path, 'utf8'), `// ${r.template} ${door()}\n`, 'the content is the injected render(template, {door})')
    }
    const mtime = fs.statSync(rec.path).mtimeMs
    routeEntry(r.kind).write(ctx, door())
    assert.equal(fs.statSync(rec.path).mtimeMs, mtime, 'intact: not rewritten')
    assert.equal(routeEntry(r.kind).check(ctx, [rec]).ok, true)
    assert.equal(routeEntry(r.kind).undo(ctx, [rec]).ok, true)
    assert.equal(bytesOf(rec.path), null)
    assert.ok(!fs.existsSync(path.dirname(rec.path)), 'the directory trocar made is gone')
  })
}

test('a group rebound to a new port rewrites that route — the old door\'s records are undone first, one set of records holds the new door, off restores the bytes', () => {
  for (const { h, id, r } of ROUTES) {
    const w = world({ persistent: PERSIST })
    const ctx = ctxFor(w, h, id)
    const file = r.file ? resolveLoc(r.file, ctx)[0] : null
    const before = file ? userText(r, { spell: 1, noProxy: true, eol: '\n' }) : null
    if (file) put(file, before)
    const n = routeEntry(r.kind).write(ctx, door(18001)).records.length
    const res = routeEntry(r.kind).write(ctx, door(18555))
    assert.equal(res.records.length, n, `${h.name}.${id}`)
    assert.ok(res.records.every((x) => x.door_sha256 === sha256(door(18555))), `${h.name}.${id}`)
    if (file) for (const k of r.proxyKeys) assert.equal(valueIn(r, fs.readFileSync(file, 'utf8'), k), door(18555), `${h.name}.${id}`)
    routeEntry(r.kind).undo(ctx, res.records)
    if (file) assert.equal(fs.readFileSync(file, 'utf8'), before, `${h.name}.${id}`)
  }
})

// A route that writes into the env the agent loads into its own process and hands to every process it starts (a .env block; a settings `env` object):
// it names a door for every proxy variable the agent reads, so a child's plain http (absolute form, which the door takes: 4.8 §5.1) goes through the
// door too. The user's own value of any of them is the prior and comes back on off, byte for byte.
const leaf = (k) => (typeof k === 'string' ? k : k.at(-1))
const intoProcessEnv = (r) => r.kind === 'dotenv-block' || (r.kind === 'json-key' && (r.proxyKeys || []).some((k) => k.length === 2 && k[0] === 'env'))
for (const { h, id, r } of ROUTES.filter((x) => intoProcessEnv(x.r))) {
  test(`P5 ${h.name}.${id} — every proxy variable the agent reads is the door; the user's HTTP_PROXY is the prior; off restores the bytes`, () => {
    const leaves = r.proxyKeys.map(leaf)
    for (const name of h.proxy.env) assert.ok(leaves.includes(name), `${name} is written`)
    const key = r.proxyKeys.find((k) => leaf(k) === 'HTTP_PROXY')
    const w = world({ persistent: PERSIST })
    const ctx = ctxFor(w, h, id)
    const file = resolveLoc(r.file, ctx)[0]
    // the user's own HTTP_PROXY, ALL_PROXY where the agent reads it, and NO_PROXY: theirs survive, off takes out only trocar's
    const mine = { HTTP_PROXY: USER_PROXY, ...(leaves.includes('ALL_PROXY') ? { ALL_PROXY: 'socks5://user.example:1080' } : {}), NO_PROXY: '.corp.example' }
    const before = r.kind === 'dotenv-block' ? `KEEP=x\n${Object.entries(mine).map(([k, v]) => `${k}=${v}\n`).join('')}` : `${JSON.stringify({ env: { ...mine, KEEP: 'x' }, unrelated: 'keep' }, null, 2)}\n`
    put(file, before)
    const recs = routeEntry(r.kind).write(ctx, door()).records
    const now = fs.readFileSync(file, 'utf8')
    for (const k of r.proxyKeys) assert.equal(valueIn(r, now, k), door(), leaf(k))
    const prior = r.kind === 'dotenv-block' ? recs[0].prior_value[key] : recs.find((x) => JSON.stringify(x.keys) === JSON.stringify(key)).prior_value
    assert.equal(prior, USER_PROXY)
    routeEntry(r.kind).undo(ctx, recs)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  })
}
