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
function userText(route, { spell, noProxy, eol }) {
  const proxy = (route.proxyKeys || []).slice(0, spell)
  if (route.kind === 'dotenv-block') {
    const lines = ['OPENAI_API_KEY=sk-user-secret', ...proxy.map((k) => `${k}=${USER_PROXY}`), ...(noProxy && route.noProxyKeys ? [`${route.noProxyKeys[0]}=${USER_NO}`] : [])]
    return lines.join(eol) + eol
  }
  const doc = { unrelated: 'keep' }
  const set = (keys, v) => { let o = doc; for (const k of keys.slice(0, -1)) o = o[k] ??= {}; o[keys.at(-1)] = v }
  for (const k of proxy) set(k, USER_PROXY)
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
      assert.ok(recs.length > 0 && recs.every((x) => x.phase === 'on' && x.route === id && x.door === door() && !CERT_KINDS.has(x.kind)), label)
      if (r.kind === 'dotenv-block') {
        assert.ok(now.startsWith(original ?? ''), `${label}: CM17 the user's lines stay first, byte for byte; nothing is commented out`)
        if (s.spell) assert.equal(recs[0].prior_value[r.proxyKeys[0]], USER_PROXY, `${label}: CM17 the user's value is the prior`)
      } else if (s.spell) assert.equal(recs.find((x) => JSON.stringify(x.keys) === JSON.stringify(r.proxyKeys[0])).prior_value, USER_PROXY, `${label}: the replaced value is the prior`)
      if (exists) assert.ok(recs.every((x) => x.backup && fs.existsSync(x.backup) && path.dirname(x.backup).startsWith(backupDir(w.home))), `${label}: the user's file was saved to ~/.trocar/backup first`)
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
    assert.ok(res.records.every((x) => x.door === door(18555)), `${h.name}.${id}`)
    if (file) for (const k of r.proxyKeys) assert.equal(valueIn(r, fs.readFileSync(file, 'utf8'), k), door(18555), `${h.name}.${id}`)
    routeEntry(r.kind).undo(ctx, res.records)
    if (file) assert.equal(fs.readFileSync(file, 'utf8'), before, `${h.name}.${id}`)
  }
})
