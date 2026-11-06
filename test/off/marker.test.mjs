// test/off/marker.test.mjs — src/off/marker.mjs (RFC 1.6 R3 「按标记撤销」, 4.6 §安装清单与卸载): undoing trocar's changes with no manifest, by trocar's own
// marks — sentinel blocks and lines, JSON values that point under ~/.trocar, the plugins and shims trocar wrote — at the places each harness keeps its entry.
// The Linux cases install all seven harnesses through the real installCollector into a sandbox HOME, then delete the manifest and work from the HOME alone;
// the macOS / Windows cases write each routing plugin through `on`'s own route writer.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installCollector } from '../../src/collector/install.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { ANONYMOUS_MODULE_MANIFEST } from '../../src/collector/harness/_plugins.mjs'
import { HARNESS_IDS } from '../../src/off/harness-names.mjs'
import { planByMarker, undoByMarker, MARKER_PATHS } from '../../src/off/marker.mjs'
import { backupsOf, writeBackup } from '../../src/off/backup.mjs'
import { manifestPath } from '../../src/off/manifest.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sevenHomes } from './fixtures/seven-homes.mjs'
import { world, door } from '../collector/core/proxymode/fixtures/entries-ctx.mjs'
import { routeEntry, noProxyNames } from '../../src/collector/core/proxymode/entries.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { resolveLoc, dirsFor } from '../../src/off/loc.mjs'

// these Linux cases look as `uninstall` does with its record lost: install's certificate carriers too (`off` spares them, tested below)
const UNINSTALL = { phases: ['install', 'on'], platform: 'linux' }
const roots = { node: [createCa({ commonName: 'marker root' }).certPem], osText: '' }
const read = (f) => fs.readFileSync(f, 'utf8')

// all seven installed over a HOME where Claude Code already had its own NODE_EXTRA_CA_CERTS and Hermes its own SSL_CERT_FILE (both replaced / put out of
// effect by trocar); the manifest is then gone
async function lostManifest() {
  const home = tmpDir('trocar-marker-')
  const sh = sevenHomes(home)
  const cc = sh.files['claude-code'][0], hermes = sh.files.hermes[0]
  fs.writeFileSync(cc, `{\n  "model": "x",\n  "env": {\n    "NODE_EXTRA_CA_CERTS": ${JSON.stringify(sh.corp)}\n  }\n}\n`)
  fs.writeFileSync(hermes, `OPENAI_API_KEY=sk-test-hermes\nSSL_CERT_FILE=${sh.corp}\n`)
  const original = Object.fromEntries(Object.values(sh.files).flat().map((f) => [f, read(f)]))
  await installCollector({ home, env: { HOME: home }, osName: 'linux', harnesses: await loadHarnesses(), freePort: async () => 47011, scan: async () => [], roots })
  const dir = path.join(home, '.trocar', 'collector')
  fs.rmSync(manifestPath(dir))
  return { home, sh, original, dir, rel: (p) => path.relative(home, p) }
}

test('planByMarker finds, with no manifest, every change of every harness by trocar\'s own marks, and plans the values and blocks before the lines before the plugins', async () => {
  const s = await lostManifest()
  const plan = planByMarker({ home: s.home, ...UNINSTALL })
  const rank = (p) => (p.how === 'owned-file' ? 2 : p.how === 'line' ? 1 : 0)
  assert.deepEqual(plan.map(rank), plan.map(rank).sort(), 'values and blocks, then lines, then owned files')
  assert.deepEqual([...new Set(plan.map((p) => p.harness))].sort(), [...HARNESS_IDS].sort(), 'every harness installed is found')
  assert.deepEqual(plan.find((p) => p.harness === 'hermes').detail, { blocks: 1, commented: 1 }, 'the block, and the line of the user it put out of effect')
  assert.deepEqual(planByMarker({ home: s.home, ...UNINSTALL, ids: ['codex', 'kimi-code'] }).map((p) => [p.harness, p.how]), [['codex', 'block'], ['kimi-code', 'line'], ['kimi-code', 'owned-file']])
  assert.deepEqual(Object.keys(MARKER_PATHS).sort(), [...HARNESS_IDS].sort(), 'every harness has places to look')
})

test('undoByMarker takes trocar out of each file and nothing else: blocks and lines go and the commented user line comes back byte for byte; a replaced JSON value comes back from the newest backup, that key only; plugins and the shim go', async () => {
  const s = await lostManifest()
  const cc = s.sh.files['claude-code'][0]
  const doc = JSON.parse(read(cc)); doc.theme = 'dark'; fs.writeFileSync(cc, JSON.stringify(doc, null, 2) + '\n') // the user edits the file after install (CC rewrites its settings)
  const plan = planByMarker({ home: s.home, ...UNINSTALL })
  const results = undoByMarker(plan, { home: s.home })
  assert.deepEqual(results.map((r) => r.result), plan.map(() => 'undone-by-marker'), 'the code `off` records and the receipt shows')
  const by = (h, how) => results.find((r) => r.harness === h && r.how === how)
  assert.equal(read(s.sh.files.codex[0]), s.original[s.sh.files.codex[0]], 'a block: byte for byte')
  assert.equal(read(s.sh.files.hermes[0]), s.original[s.sh.files.hermes[0]], 'the block is out and the user\'s own SSL_CERT_FILE line is back as it was')
  assert.equal(by('hermes', 'block').restored, 1)
  assert.equal(read(s.sh.files['kimi-code'][0]), s.original[s.sh.files['kimi-code'][0]], 'a line')
  assert.deepEqual(JSON.parse(read(cc)), { model: 'x', env: { NODE_EXTRA_CA_CERTS: s.sh.corp }, theme: 'dark' }, 'the user\'s value is back from the backup and the edit made since stays: one key, never the whole file')
  assert.equal(by('claude-code', 'json-value').restored_from, backupsOf({ home: s.home, file: cc }).at(-1))
  assert.deepEqual(JSON.parse(read(s.sh.files['z-code'][0])), { model: 'lab/m', network: {} }, 'a key trocar added, with no backup of a value, just goes')
  assert.ok(!fs.existsSync(s.sh.files['deepseek-dsh'][0]), 'the dsh patch file held only trocar\'s row (it was `[]`): dsh does not start on an empty file, so it is removed')
  for (const gone of ['.config/opencode/plugins', '.trocar/collector/bin', '.trocar/collector/plugins']) assert.ok(!fs.existsSync(path.join(s.home, gone)), `${gone} is gone, the directory too`)
  assert.ok(fs.existsSync(path.join(s.home, '.trocar', 'collector', 'ca', 'trocar-ca.pem')), 'the CA is trocar\'s, not an entry: marker undo leaves it for uninstall')
  assert.deepEqual(planByMarker({ home: s.home, ...UNINSTALL }), [], 'nothing of trocar\'s is left to find')
  assert.deepEqual(undoByMarker(planByMarker({ home: s.home, ...UNINSTALL }), { home: s.home }), [], 'and a second run does nothing')
})

test('what is not trocar\'s is not touched: a plugin file of the user\'s, a PATH line without the sentinel comment, a JSON value that does not point under ~/.trocar, a conda block', async () => {
  const home = tmpDir('trocar-marker-own-')
  const put = (rel, t) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return f }
  const plugin = put('.config/opencode/plugins/trocar-ca.js', '// mine, not trocar\'s\n')
  const rc = put('.bashrc', '# >>> conda initialize >>>\nexport PATH="/opt/conda/bin:$PATH"\n# <<< conda initialize <<<\nexport PATH="/home/u/.trocar/collector/bin:$PATH"\n') // looks like the shim line, has no sentinel comment
  const cc = put('.claude/settings.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: '/corp/relay.pem' } }))
  const env = put('.codex/.env', `# >>> something else >>>\nSSL_CERT_FILE=${path.join(home, '.trocar', 'collector', 'ca', 'x.pem')}\n`)
  const before = [plugin, rc, cc, env].map(read)
  assert.deepEqual(planByMarker({ home, ...UNINSTALL }), [])
  const forged = [{ harness: 'opencode', path: plugin, how: 'owned-file', detail: {} }, { harness: 'kimi-code', path: rc, how: 'line', detail: {} }, { harness: 'claude-code', path: cc, how: 'json-value', detail: { keys: ['env', 'NODE_EXTRA_CA_CERTS'] } }]
  assert.deepEqual(undoByMarker(forged, { home }).map((r) => r.result), ['already-clean', 'already-clean', 'already-clean'], 'a plan is never trusted over the file: the mark is looked for again')
  assert.deepEqual([plugin, rc, cc, env].map(read), before)
})

test('a replaced JSON value comes back from the NEWEST backup of that file; a backup holding no such key removes it; a file that no longer parses is left as it is', async () => {
  const home = tmpDir('trocar-marker-json-')
  const file = path.join(home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(file), { recursive: true })
  const ours = path.join(home, '.trocar', 'collector', 'ca', 'trocar-ca.pem')
  let n = 0 // each backup a second after the one before: the newest sorts last
  const bk = (v) => writeBackup({ home, file, data: Buffer.from(JSON.stringify({ env: v === undefined ? {} : { NODE_EXTRA_CA_CERTS: v }, model: 'old' })), now: new Date(Date.UTC(2026, 9, 7, 1, 0, ++n)) })
  bk('/corp/first.pem'); bk('/corp/second.pem')
  fs.writeFileSync(file, `{ "env": { "NODE_EXTRA_CA_CERTS": ${JSON.stringify(ours)} }, "model": "edited by the user" }`)
  const [r] = undoByMarker(planByMarker({ home, ...UNINSTALL }), { home })
  assert.deepEqual([r.result, r.value], ['undone-by-marker', '/corp/second.pem'])
  assert.equal(read(file), '{ "env": { "NODE_EXTRA_CA_CERTS": "/corp/second.pem" }, "model": "edited by the user" }', 'a text splice of one value: every other byte of the file as it is')
  // the newest backup has no such key: the key goes
  bk(undefined)
  fs.writeFileSync(file, `{ "env": { "NODE_EXTRA_CA_CERTS": ${JSON.stringify(ours)}, "A": "1" } }`)
  const [r2] = undoByMarker(planByMarker({ home, ...UNINSTALL }), { home })
  assert.deepEqual([r2.result, r2.removed, JSON.parse(read(file))], ['undone-by-marker', true, { env: { A: '1' } }])
  // a file that does not parse: left
  const broken = `{ "env": { "NODE_EXTRA_CA_CERTS": ${JSON.stringify(ours)} } trailing`
  fs.writeFileSync(file, broken)
  assert.deepEqual(planByMarker({ home, ...UNINSTALL }), [], 'it cannot be read as JSON, so no value of it is found')
  assert.deepEqual(undoByMarker([{ harness: 'claude-code', path: file, how: 'json-value', detail: { keys: ['env', 'NODE_EXTRA_CA_CERTS'] } }], { home }).map((x) => x.result), ['left-unparsable'])
  assert.equal(read(file), broken)
})

// the axes: how the newest backup cannot be read × what the older ones hold. A backup that cannot be read is skipped, never taken for "no value": the value
// comes back from an older one; with none found and one skipped, the key stays and the result says which backup could not be read (D38)
for (const [bad, write] of [['not JSON', (f) => fs.writeFileSync(f, '{ not json')], ['no encoding', (f) => fs.writeFileSync(f, Buffer.from([0xff, 0xfe, 0x41]))], ['unreadable', (f) => { fs.rmSync(f); fs.mkdirSync(f) }]]) {
  for (const older of ['a value', 'no such key', 'unreadable too', 'none']) {
    test(`marker undo, the newest backup ${bad}, the older ones: ${older}`, () => {
      const home = tmpDir('trocar-marker-bk-')
      const file = path.join(home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(file), { recursive: true })
      const ours = path.join(home, '.trocar', 'collector', 'ca', 'trocar-ca.pem')
      let n = 0
      const bk = (doc) => writeBackup({ home, file, data: Buffer.from(JSON.stringify(doc)), now: new Date(Date.UTC(2026, 9, 7, 1, 0, ++n)) })
      if (older === 'a value') bk({ env: { NODE_EXTRA_CA_CERTS: '/corp/older.pem' } })
      if (older === 'no such key') bk({ env: {} })
      if (older === 'unreadable too') write(bk({}))
      const newest = bk({}); write(newest)
      const text = `{ "env": { "NODE_EXTRA_CA_CERTS": ${JSON.stringify(ours)}, "A": "1" }, "model": "m" }`
      fs.writeFileSync(file, text)
      const [r] = undoByMarker([{ harness: 'claude-code', path: file, how: 'json-value', detail: { keys: ['env', 'NODE_EXTRA_CA_CERTS'] } }], { home })
      if (older === 'a value') {
        assert.deepEqual([r.result, r.value, r.restored_from], ['undone-by-marker', '/corp/older.pem', backupsOf({ home, file })[0]])
        assert.equal(read(file), text.replace(JSON.stringify(ours), '"/corp/older.pem"'), 'that one value: every other byte as it was')
      } else {
        assert.notEqual(r.result, 'undone-by-marker', 'the user\'s value may be in the backup that could not be read: the key is not removed')
        assert.equal(read(file), text, 'the file is not touched')
        assert.ok(r.backups.includes(newest), 'the result names the backup that could not be read')
      }
    })
  }
}

test('a block whose close line the user deleted still goes (its variables under ~/.trocar with it), a dsh patch file with the user\'s rows keeps them, and the plugin manifest text is the collector\'s own', async () => {
  const home = tmpDir('trocar-marker-block-')
  const root = path.join(home, '.trocar')
  const env = path.join(home, '.codex', '.env'); fs.mkdirSync(path.dirname(env), { recursive: true })
  fs.writeFileSync(env, `# >>> trocar collector >>> written by \`trocar collector install\`; \`trocar collector uninstall\` removes this block\nSSL_CERT_FILE=${root}/collector/ca/combined-codex.pem\nOPENAI_API_KEY=sk-1\n#trocar-collector-off# SSL_CERT_FILE=/corp/own.pem\n`)
  const patch = path.join(home, '.dsh', 'cordis.patch.yml'); fs.mkdirSync(path.dirname(patch), { recursive: true })
  fs.writeFileSync(patch, `- set: {a: 1}\n- insert: [{ name: "${root}/collector/plugins/dsh/index.js" }] # trocar collector: loads trocar's CA trust plugin\n- insert: [{ name: mine }]\n`)
  assert.deepEqual(undoByMarker(planByMarker({ home, ...UNINSTALL }), { home }).map((r) => r.result), ['undone-by-marker', 'undone-by-marker'])
  assert.equal(read(env), 'OPENAI_API_KEY=sk-1\nSSL_CERT_FILE=/corp/own.pem\n', 'the open line and the variable under ~/.trocar are out, the user\'s API key stays, the commented line is back')
  assert.equal(read(patch), '- set: {a: 1}\n- insert: [{ name: mine }]\n')
  assert.equal(ANONYMOUS_MODULE_MANIFEST, '{"type":"module"}\n', 'src/off keeps its own copy of trocar\'s plugin manifest text; this is what keeps it equal')
  assert.ok(MARKER_PATHS['deepseek-dsh'].some((p) => p.exact === ANONYMOUS_MODULE_MANIFEST))
})

test('on Linux, install\'s certificate block in a CODEX_HOME other than ~/.codex: uninstall (install and on) finds it there, off (on) does not', () => {
  const home = tmpDir('trocar-marker-codexhome-')
  const ch = path.join(home, 'elsewhere', 'codex')
  fs.mkdirSync(ch, { recursive: true })
  const file = path.join(ch, '.env')
  fs.writeFileSync(file, `# >>> trocar collector >>>\nSSL_CERT_FILE=${path.join(home, '.trocar', 'collector', 'ca', 'combined-codex.pem')}\n# <<< trocar collector <<<\nOPENAI_API_KEY=sk-x\n`)
  const env = { HOME: home, CODEX_HOME: ch }
  assert.deepEqual(planByMarker({ home, ids: ['codex'], env, ...UNINSTALL }).map((p) => [p.path, p.how]), [[file, 'block']])
  assert.deepEqual(planByMarker({ home, ids: ['codex'], env, platform: 'linux', phases: ['on'] }), [])
})

test('D48② with no manifest: a key the user set while on keeps the user\'s value — its old line stays out of effect and is reported (prior_left); a key the user did not set comes back, also on line 1 after a mark and when an editor indented the prefix', async () => {
  const { OFF_PREFIX, blockBegin, BLOCK_END } = await import('../../src/off/text-edit.mjs')
  const home = tmpDir('trocar-marker-d48-')
  const f = path.join(home, '.codex', '.env')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const ca = path.join(home, '.trocar', 'collector', 'ca', 'combined-codex.pem')
  const block = `${blockBegin()}\nSSL_CERT_FILE=${ca}\n${BLOCK_END}\n`
  // the user set SSL_CERT_FILE again while on (below trocar's block); HTTPS_PROXY and NO_PROXY they left alone
  fs.writeFileSync(f, `﻿${OFF_PREFIX}HTTPS_PROXY=http://corp.example:8080\n${block}SSL_CERT_FILE=/mine/ca.pem\n${OFF_PREFIX}SSL_CERT_FILE=/corp/ca.pem\n  ${OFF_PREFIX}NO_PROXY=localhost\nOPENAI_API_KEY=sk-x\n`)
  const [r] = undoByMarker(planByMarker({ home, ...UNINSTALL, ids: ['codex'] }), { home })
  assert.equal(r.result, 'undone-by-marker')
  const out = read(f)
  assert.equal(out, `﻿HTTPS_PROXY=http://corp.example:8080\nSSL_CERT_FILE=/mine/ca.pem\n${OFF_PREFIX}SSL_CERT_FILE=/corp/ca.pem\n  NO_PROXY=localhost\nOPENAI_API_KEY=sk-x\n`, 'the block goes; the user\'s new value wins, the old line stays out of effect; the others come back')
  assert.equal(r.restored, 2, 'the lines that came back are counted, line 1 after the mark among them')
  assert.deepEqual(r.prior_left, [{ key: 'SSL_CERT_FILE', line: 3 }], 'the old line left out of effect is reported by line, as the journal path reports it')
})

// macOS / Windows: `on` writes class-1 routes whose bytes carry trocar's sentinel (4.11 P5): a routing plugin (plugin-file) and a proxy block in a
// dotenv file (dotenv-block). With the manifest lost, the marker undo finds each where `on` put it — the place the descriptor's route names, through the
// same resolver and the same per-user folders (appSupport / localAppData), the route's own variable (XDG_CONFIG_HOME, CODEX_HOME, …) included — and
// takes it out: the plugin goes, the user's bytes of a dotenv file come back exactly. (A json-key route's value carries no sentinel; not covered here.)
const MARKED = ['plugin-file', 'dotenv-block']
const USER_DOTENV = 'USER_KEY=kept\n'
for (const { h, id, r } of (await loadHarnesses()).flatMap((d) => Object.entries((d.proxyMode && d.proxyMode.routes) || {}).map(([id, r]) => ({ h: d, id, r }))).filter((x) => MARKED.includes(x.r.kind))) {
  for (const os of ['darwin', 'win32']) {
    const at = r.dir || r.file, l = at.perOs ? at.perOs[os] : at
    if (!l) continue
    for (const over of l.env ? [false, true] : [false]) {
      test(`${h.name} · ${id} (${r.kind}) · ${os}${over ? ` · ${l.env} set` : ''}: what \`on\` wrote is found and undone by its mark when the manifest is gone`, async () => {
        const w = world({ os })
        // Windows always names its per-user folders in the environment; set under the sandbox, so a win32 case run on another host stays in it
        if (os === 'win32') Object.assign(w.ctx.env, { APPDATA: path.join(w.root, 'roaming'), LOCALAPPDATA: path.join(w.root, 'local') })
        if (over) w.ctx.env[l.env] = path.join(w.root, 'elsewhere')
        w.ctx.dirs = dirsFor(os, w.home, w.ctx.env)
        const p = (h.proxy || {}).env || []
        const ctx = { ...w.ctx, harness: h.name, routeId: id, route: r, render: (tpl, v) => renderHook(tpl, { DOOR: v.door, PROXY_ENV: p, PROXY_NAMES: p, NO_PROXY_ENV: noProxyNames(h) }).text }
        if (r.kind === 'dotenv-block') { const f = resolveLoc(r.file, ctx)[0]; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, USER_DOTENV) }
        const res = routeEntry(r.kind).write(ctx, door())
        assert.ok(res.ok, JSON.stringify(res))
        const file = res.records[0].path
        assert.ok(path.isAbsolute(file) && file.startsWith(w.root) && fs.existsSync(file), file)
        const plan = planByMarker({ home: w.home, env: w.ctx.env, platform: os, ids: [h.name] })
        assert.deepEqual(plan.map((x) => [x.harness, x.path]), [[h.name, file]])
        assert.deepEqual(undoByMarker(plan, { home: w.home }).map((x) => x.result), ['undone-by-marker'])
        if (r.kind === 'plugin-file') assert.ok(!fs.existsSync(file))
        else assert.equal(read(file), USER_DOTENV, 'the user\'s bytes come back exactly')
      })
    }
  }
}

// Class 2 (4.11 P5): the switch file `on` writes for a hook-read route, <collector>/switch/<harness>, holding the door. It is in trocar's own tree and
// trocar created it, so with the manifest lost it is trocar's by where it is (1.6 R3 「trocar 建的开关文件」): a switch file left behind names a door the
// same off just closed, and the harness's next start cannot connect (invariant 5).
for (const { h, id, r } of (await loadHarnesses()).flatMap((d) => Object.entries((d.proxyMode && d.proxyMode.routes) || {}).map(([id, r]) => ({ h: d, id, r }))).filter((x) => x.r.kind === 'switch-file')) {
  for (const os of ['darwin', 'win32']) {
    test(`${h.name} · ${id} (switch-file) · ${os}: the switch file \`on\` wrote goes with the manifest gone, and the switch file of another harness stays`, async () => {
      const w = world({ os })
      const res = routeEntry('switch-file').write({ ...w.ctx, harness: h.name, routeId: id, route: r }, door())
      assert.ok(res.ok, JSON.stringify(res))
      const file = res.records[0].path
      assert.ok(fs.existsSync(file), file)
      const otherName = HARNESS_IDS.find((x) => x !== h.name)
      const other = routeEntry('switch-file').write({ ...w.ctx, harness: otherName, routeId: id, route: r }, door()).records[0].path // another harness's, through the same writer
      const plan = planByMarker({ home: w.home, env: w.ctx.env, platform: os, ids: [h.name] })
      assert.deepEqual(plan.map((x) => [x.harness, x.path, x.how]), [[h.name, file, 'owned-file']])
      assert.deepEqual(undoByMarker(plan, { home: w.home }).map((x) => x.result), ['undone-by-marker'])
      assert.ok(!fs.existsSync(file), 'the switch file is gone: the next start goes direct')
      assert.equal(read(other), door(), 'the switch file of a harness off was not asked about stays')
    })
  }
}

test('a switch file that is a link: the link goes, the file it names stays byte for byte', () => {
  const w = world({ os: 'darwin' })
  const mine = path.join(w.home, 'mine.txt')
  fs.writeFileSync(mine, 'the user\'s own bytes\n')
  const link = path.join(w.dir, 'switch', 'pi')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(mine, link)
  const plan = planByMarker({ home: w.home, env: w.ctx.env, platform: 'darwin', ids: ['pi'] })
  assert.deepEqual(plan.map((x) => x.path), [link])
  assert.deepEqual(undoByMarker(plan, { home: w.home }).map((x) => x.result), ['undone-by-marker'])
  assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' })
  assert.equal(read(mine), 'the user\'s own bytes\n')
})

// macOS / Windows: a json-key route's value carries no sentinel; it is trocar's when it points at one of trocar's doors — a loopback URL on a door port
// ingress.json records (1.6 R3 「指向 trocar 的值」). The value it replaced comes back from the newest backup, key by key; no such key there, the key goes.
// A loopback proxy of the user's own (a port that is no door) stays; with ingress.json unreadable nothing is guessed, and the receipt says so.
const PORT = 18001
const putIngress = (dir, port) => fs.writeFileSync(path.join(dir, 'ingress.json'), JSON.stringify({ enginePort: 17990, groupPorts: { a: port }, ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }))
const { parseJsonText, getPath: valueAt, removeKey: dropKey } = await import('../../src/off/json-text.mjs')
const without = (t, keys) => keys.reduce((s, k) => (dropKey(s, k) || { text: s }).text, t) // null: no such key
for (const { h, id, r } of (await loadHarnesses()).flatMap((d) => Object.entries((d.proxyMode && d.proxyMode.routes) || {}).map(([id, r]) => ({ h: d, id, r }))).filter((x) => x.r.kind === 'json-key' && ['door-url', 'pac-url'].includes(x.r.value))) {
  for (const os of ['darwin', 'win32']) {
    // the user's file before `on`: content of theirs and, where `on` writes over one (not a PAC route: it is not written over an own egress), a proxy of theirs
    const setup = (userProxy) => {
      const w = world({ os })
      if (os === 'win32') Object.assign(w.ctx.env, { APPDATA: path.join(w.root, 'roaming'), LOCALAPPDATA: path.join(w.root, 'local') })
      w.ctx.dirs = dirsFor(os, w.home, w.ctx.env)
      const ctx = { ...w.ctx, harness: h.name, routeId: id, route: r }
      let file
      if (r.select) {
        const dir = resolveLoc(r.select.dir, ctx)[0]
        if (!dir) return null
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, r.select.meta), JSON.stringify({ [r.select.idKey]: 'mine' }))
        file = path.join(dir, 'mine.json')
      } else { file = resolveLoc(r.file, ctx)[0]; if (!file) return null }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const doc = { keep: 1 }
      if (userProxy) { let at = doc; r.proxyKeys[0].slice(0, -1).forEach((k) => { at = at[k] = {} }); at[r.proxyKeys[0].at(-1)] = userProxy }
      fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
      return { w, ctx, file }
    }
    const own = r.value === 'pac-url' ? null : 'http://corp.example:8080'
    test(`${h.name} · ${id} (json-key) · ${os}: the door value \`on\` wrote goes with the manifest gone, the replaced value back from the backup, every other byte as it was`, () => {
      const s = setup(own)
      if (!s) return
      putIngress(s.w.dir, PORT)
      const pre = read(s.file)
      const res = routeEntry('json-key').write(s.ctx, door(PORT))
      assert.ok(res.ok, JSON.stringify(res))
      const plan = planByMarker({ home: s.w.home, env: s.w.ctx.env, platform: os, ids: [h.name] }).filter((x) => x.path === s.file)
      assert.deepEqual(plan.map((x) => x.detail.keys), [r.proxyKeys], 'each door key of the file is found, the file once')
      assert.deepEqual(undoByMarker(plan, { home: s.w.home }).map((x) => x.result), plan.map(() => 'undone-by-marker'))
      const out = read(s.file), doc = parseJsonText(out)
      r.proxyKeys.forEach((k, i) => assert.equal(valueAt(doc, k), i === 0 && own ? own : undefined, k.join('.')))
      assert.equal(out, pre, 'the file is byte for byte as before on')
    })
    test(`${h.name} · ${id} (json-key) · ${os}: a loopback proxy of the user's own (no door port) stays, and with ingress.json unreadable no value is guessed a door`, () => {
      const s = setup(null)
      if (!s) return
      putIngress(s.w.dir, PORT)
      for (const value of ['http://127.0.0.1:7890', `http://corp.example:${PORT}`]) { // a loopback port that is no door; a door port on a host that is not loopback
        const mine = setup(value)
        putIngress(mine.w.dir, PORT)
        const before = read(mine.file)
        const plan = planByMarker({ home: mine.w.home, env: mine.w.ctx.env, platform: os, ids: [h.name] })
        assert.deepEqual(plan.filter((x) => x.path === mine.file), [], value)
        undoByMarker(plan, { home: mine.w.home })
        assert.equal(read(mine.file), before, value)
      }
      // the door written, then ingress.json gone: not undone, and said
      assert.ok(routeEntry('json-key').write(s.ctx, door(PORT)).ok)
      fs.rmSync(path.join(s.w.dir, 'ingress.json'))
      const on = read(s.file), notes = []
      const plan2 = planByMarker({ home: s.w.home, env: s.w.ctx.env, platform: os, ids: [h.name], notes })
      assert.deepEqual(plan2.filter((x) => x.path === s.file), [])
      undoByMarker(plan2, { home: s.w.home })
      assert.equal(read(s.file), on)
      assert.ok(notes.some((n) => n.includes(s.file)), JSON.stringify(notes))
    })
    test(`${h.name} · ${id} (json-key) · ${os}: a file holding a door value that no longer parses is left as it is and said (left-unparsable); with ingress.json unreadable it is said, not guessed`, () => {
      const s = setup(null)
      if (!s) return
      putIngress(s.w.dir, PORT)
      assert.ok(routeEntry('json-key').write(s.ctx, door(PORT)).ok)
      fs.appendFileSync(s.file, '{ broken')
      const broken = read(s.file)
      const plan = planByMarker({ home: s.w.home, env: s.w.ctx.env, platform: os, ids: [h.name] }).filter((x) => x.path === s.file)
      assert.equal(plan.length, 1, 'the file is planned: a door is in it')
      assert.deepEqual(undoByMarker(plan, { home: s.w.home }).map((x) => x.result), ['left-unparsable'])
      assert.equal(read(s.file), broken)
      fs.rmSync(path.join(s.w.dir, 'ingress.json'))
      const notes = []
      assert.deepEqual(planByMarker({ home: s.w.home, env: s.w.ctx.env, platform: os, ids: [h.name], notes }).filter((x) => x.path === s.file), [])
      assert.ok(notes.some((n) => n.includes(s.file)), JSON.stringify(notes))
    })
  }
}

// the same through `off` itself on macOS (runOff, its receipt, its --dry-run): the door value is undone after a yes, and with ingress.json unreadable the
// receipt names the file it left. One route stands for all: the generated cases above cover each.
test('off on darwin with the manifest gone: --yes takes the door value out (undone-by-marker); with ingress.json unreadable the receipt, real and dry run, names the file and it stays', async () => {
  const { runOff } = await import('../../src/off/orchestrate.mjs')
  const zc = (await loadHarnesses()).find((d) => d.name === 'z-code')
  const [id, r] = Object.entries(zc.proxyMode.routes).find(([, x]) => x.kind === 'json-key')
  const s = (() => { const w = world({ os: 'darwin' }); const ctx = { ...w.ctx, harness: zc.name, routeId: id, route: r }; return { w, ctx, file: resolveLoc(r.file, ctx)[0] } })()
  fs.mkdirSync(path.dirname(s.file), { recursive: true }); fs.writeFileSync(s.file, '{ "keep": 1 }\n')
  putIngress(s.w.dir, PORT)
  assert.ok(routeEntry('json-key').write(s.ctx, door(PORT)).ok)
  const off = (o) => runOff({ home: s.w.home, env: { HOME: s.w.home }, ids: [zc.name], ...o, deps: { platform: 'darwin', exec: () => ({ status: 1, stdout: '', stderr: 'no tool here' }), procs: async () => [], sleep: async () => {} } })
  fs.rmSync(manifestPath(s.w.dir))
  const on = read(s.file)
  fs.rmSync(path.join(s.w.dir, 'ingress.json'))
  for (const o of [{ dryRun: true }, { yes: true }]) {
    const { receipt } = await off(o)
    assert.ok(receipt.notes.some((n) => n.includes(s.file)), `${JSON.stringify(o)}: ${JSON.stringify(receipt.notes)}`)
    assert.equal(read(s.file), on)
  }
  putIngress(s.w.dir, PORT)
  const { receipt, exit } = await off({ yes: true })
  assert.deepEqual([exit, receipt.undone_by_marker], [0, true], JSON.stringify(receipt.problems))
  r.proxyKeys.forEach((k) => assert.equal(valueAt(parseJsonText(read(s.file)), k), undefined, k.join('.')))
})

// D55① with the manifest gone: the certificate carriers are `install`'s, so `off --yes` undoing by trocar's marks leaves every one of them byte for
// byte (4.6 §安装清单与卸载: 证书块、合并包、信任插件与 CA 按标记撤销也不碰), while what `on` wrote still goes. The carriers are every install-phase item
// the real install recorded, on Linux (installCollector) and on macOS (runInstall, every harness present), the Kimi shim and its rc line among them.
const { itemsOfPhase, readManifest } = await import('../../src/off/manifest.mjs')
const quietDeps = (platform) => ({ platform, exec: () => ({ status: 1, stdout: '', stderr: 'no tool here' }), procs: async () => [], sleep: async () => {} })
const carriersOf = (dir) => [...new Set(itemsOfPhase(readManifest(dir), 'install').filter((x) => x.harness).map((x) => x.path))]
const bytesOf = (files) => Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, 'latin1') : null]))
for (const os of ['linux', 'darwin']) {
  test(`${os}: off --yes with the manifest gone leaves every install-phase certificate carrier byte for byte; what on wrote goes`, async () => {
    const { runOff } = await import('../../src/off/orchestrate.mjs')
    let home, dir, onFile, onKeys, carriers
    if (os === 'linux') {
      ;({ home, dir } = await lostManifestKeep())
      carriers = carriersOf(dir)
    } else {
      const { modelWorld } = await import('../helpers/model-world.mjs')
      const w = await modelWorld({ commands: ['claude', 'codex', 'dsh', 'kimi'], env: { CLAUDE_CODE_CERT_STORE: 'bundled' } })
      for (const d of ['.zcode', '.dsh', '.pi/agent']) fs.mkdirSync(path.join(w.home, d), { recursive: true })
      await w.install()
      ;({ home, dir } = w)
      carriers = carriersOf(dir)
      // what `on` writes next to an install-phase key: Z-Code's door, in the config.json that holds caCertFile (a macOS test machine: off took both)
      const zc = (await loadHarnesses()).find((d) => d.name === 'z-code')
      const [id, r] = Object.entries(zc.proxyMode.routes).find(([, x]) => x.kind === 'json-key')
      putIngress(dir, PORT)
      const res = routeEntry('json-key').write({ ...world({ os }).ctx, home, dir, env: { HOME: home }, dirs: dirsFor(os, home, { HOME: home }), harness: zc.name, routeId: id, route: r }, door(PORT))
      assert.ok(res.ok, JSON.stringify(res))
      onFile = res.records[0].path; onKeys = r.proxyKeys
    }
    assert.ok(carriers.length >= 5, JSON.stringify(carriers))
    const before = bytesOf(carriers)
    fs.rmSync(manifestPath(dir))
    const { receipt } = await runOff({ home, env: { HOME: home }, yes: true, deps: quietDeps(os) })
    const after = bytesOf(carriers)
    const but = (f, t) => (f === onFile && t != null ? without(t, onKeys) : t) // the file that also holds on's door: every byte but its keys
    assert.deepEqual(carriers.filter((f) => but(f, after[f]) !== but(f, before[f])), [], 'changed by off')
    if (onFile) onKeys.forEach((k) => assert.equal(valueAt(parseJsonText(read(onFile)), k), undefined, `${k.join('.')} (on's) is undone`))
  })
}
// lostManifest, the manifest kept for the caller to read first
async function lostManifestKeep() {
  const home = tmpDir('trocar-marker-keep-')
  const sh = sevenHomes(home)
  await installCollector({ home, env: { HOME: home }, osName: 'linux', harnesses: await loadHarnesses(), freePort: async () => 47011, scan: async () => [], roots })
  return { home, sh, dir: path.join(home, '.trocar', 'collector') }
}

// Linux, the record lost: the Kimi launch shim and its rc PATH line are install's (4.6 Kimi row, D55①), in whichever rc file holds the installer's line.
// `off --yes` leaves both byte for byte; `uninstall`'s marker undo (both phases) takes them, and the rc file is as it was before install.
for (const rcName of MARKER_PATHS['kimi-code'].filter((x) => x.how === 'line').map((x) => x.file)) {
  test(`linux, ${rcName}: off by marker leaves the Kimi shim and rc line byte for byte; uninstall by marker takes them`, async () => {
    const { runOff } = await import('../../src/off/orchestrate.mjs')
    const home = tmpDir('trocar-marker-kimi-')
    sevenHomes(home)
    fs.rmSync(path.join(home, '.bashrc'))
    const rc = path.join(home, rcName), shim = path.join(home, '.trocar', 'collector', 'bin', 'kimi')
    const original = '# kimi-code\nexport PATH="$HOME/.kimi-code/bin:$PATH"\n'
    fs.writeFileSync(rc, original)
    await installCollector({ home, env: { HOME: home }, osName: 'linux', harnesses: (await loadHarnesses()).filter((d) => d.name === 'kimi-code'), freePort: async () => 47011, scan: async () => [], roots })
    const dir = path.join(home, '.trocar', 'collector')
    const before = bytesOf([rc, shim])
    assert.ok(before[shim] != null && before[rc] !== original, 'install wrote the shim and the rc line')
    fs.rmSync(manifestPath(dir))
    assert.deepEqual(planByMarker({ home, env: { HOME: home }, platform: 'linux', ids: ['kimi-code'] }), [], 'off plans nothing for Kimi')
    const { exit } = await runOff({ home, env: { HOME: home }, yes: true, deps: quietDeps('linux') })
    assert.equal(exit, 0)
    assert.deepEqual(bytesOf([rc, shim]), before, 'off left both')
    const plan = planByMarker({ home, env: { HOME: home }, ids: ['kimi-code'], ...UNINSTALL })
    assert.deepEqual(plan.map((p) => [p.path, p.how]), [[rc, 'line'], [shim, 'owned-file']])
    assert.deepEqual(undoByMarker(plan, { home }).map((r) => r.result), ['undone-by-marker', 'undone-by-marker'])
    assert.deepEqual([read(rc), fs.existsSync(shim)], [original, false])
  })
}

// Everything `on` writes beside a door key, with the manifest gone (1.6 §3.4): the NO_PROXY keys (loopback + the user's value, P6), the `arrayItems`
// element, the objects and arrays made to hold them, an entry `select` created and the meta key that selects it. Generated from each json-key door
// route × the user's file before `on` (none; theirs, with a value at each such key; theirs, with the containers already there and empty): after
// the marker undo every file is byte for byte as before `on` (absent when it was absent), and the plan counts each file once.
const DOOR_KINDS = (await loadHarnesses()).flatMap((d) => Object.entries((d.proxyMode && d.proxyMode.routes) || {}).map(([id, r]) => ({ h: d, id, r }))).filter((x) => x.r.kind === 'json-key' && ['door-url', 'pac-url'].includes(x.r.value))
const plant = (doc, keys, v) => { let at = doc; keys.slice(0, -1).forEach((k) => { at = at[k] = at[k] || {} }); at[keys.at(-1)] = v }
const userStates = (r) => ({
  none: null,
  own: (() => { const d = { keep: 1 }; for (const k of r.noProxyKeys || []) plant(d, k, 'corp.example'); for (const a of r.arrayItems || []) plant(d, a.keys, ['editor.fontSize']); return d })(),
  empty: (() => { const d = { keep: 1 }; for (const k of [...r.proxyKeys, ...(r.noProxyKeys || [])]) if (k.length > 1) plant(d, k.slice(0, -1), {}); for (const a of r.arrayItems || []) plant(d, a.keys, []); for (const k of r.proxyKeys) if (k.length > 1) { let at = d; k.slice(0, -1).forEach((x) => { at = at[x] }); delete at[k.at(-1)] } return d })(),
})
for (const { h, id, r } of DOOR_KINDS) {
  for (const os of ['darwin', 'win32']) {
    for (const [state, doc] of Object.entries(userStates(r))) {
      test(`${h.name} · ${id} · ${os} · user file ${state}: with the manifest gone, every file on wrote is byte for byte as before on, each counted once`, () => {
        const w = world({ os })
        if (os === 'win32') Object.assign(w.ctx.env, { APPDATA: path.join(w.root, 'roaming'), LOCALAPPDATA: path.join(w.root, 'local') })
        w.ctx.dirs = dirsFor(os, w.home, w.ctx.env)
        const ctx = { ...w.ctx, harness: h.name, routeId: id, route: r }
        const pre = new Map() // the user's files before on; a file on wrote that is not here was not there
        const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); pre.set(f, t) }
        let file
        if (r.select) {
          const dir = resolveLoc(r.select.dir, ctx)[0]
          if (!dir) return
          file = path.join(dir, 'mine.json')
          if (doc) put(path.join(dir, r.select.meta), `{\n  "other": 2,\n  "${r.select.idKey}": "mine"\n}\n`)
        } else { file = resolveLoc(r.file, ctx)[0]; if (!file) return }
        if (doc) put(file, `${JSON.stringify(doc, null, 2)}\n`)
        putIngress(w.dir, PORT)
        const res = routeEntry('json-key').write(ctx, door(PORT))
        assert.ok(res.ok, JSON.stringify(res))
        const touched = [...new Set(res.records.map((x) => x.path))]
        const before = Object.fromEntries(touched.map((f) => [f, pre.get(f) ?? null]))
        fs.rmSync(manifestPath(w.dir), { force: true })
        const plan = planByMarker({ home: w.home, env: w.ctx.env, platform: os, ids: [h.name] })
        assert.equal(new Set(plan.map((x) => x.path)).size, plan.length, 'one plan item per file')
        const results = undoByMarker(plan, { home: w.home })
        assert.ok(results.every((x) => x.result === 'undone-by-marker'), JSON.stringify(results))
        for (const f of touched) assert.equal(fs.existsSync(f) ? read(f) : null, before[f], f)
      })
    }
  }
}

// An entry `select` created beside a meta file of the user's (no selecting key, or one naming an entry that is gone): the meta's backup gives the user's
// bytes back and the entry goes; when that backup cannot be read, neither file is touched and both are named — the entry is never deleted under a meta
// still selecting it (the next off could no longer find it).
for (const { h, id, r } of DOOR_KINDS.filter((x) => x.r.select)) {
  for (const os of ['darwin', 'win32']) {
    for (const [state, metaText] of [['no selecting key', '{\n  "other": 2\n}\n'], ['naming a gone entry', `{\n  "other": 2,\n  "${r.select.idKey}": "gone"\n}\n`]]) {
      for (const backup of ['readable', 'unreadable']) {
        test(`${h.name} · ${id} · ${os} · meta ${state}, its backup ${backup}: the created entry and the meta key undo together or not at all`, () => {
          const w = world({ os })
          if (os === 'win32') Object.assign(w.ctx.env, { APPDATA: path.join(w.root, 'roaming'), LOCALAPPDATA: path.join(w.root, 'local') })
          w.ctx.dirs = dirsFor(os, w.home, w.ctx.env)
          const ctx = { ...w.ctx, harness: h.name, routeId: id, route: r }
          const dir = resolveLoc(r.select.dir, ctx)[0]
          if (!dir) return
          const meta = path.join(dir, r.select.meta)
          fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(meta, metaText)
          putIngress(w.dir, PORT)
          const res = routeEntry('json-key').write(ctx, door(PORT))
          assert.ok(res.ok, JSON.stringify(res))
          const entry = res.records.map((x) => x.path).find((f) => f !== meta)
          assert.ok(entry && fs.existsSync(entry))
          fs.rmSync(manifestPath(w.dir), { force: true })
          if (backup === 'unreadable') for (const b of backupsOf({ home: w.home, file: meta })) fs.writeFileSync(b, '{ not json')
          const onEntry = read(entry), onMeta = read(meta)
          const results = undoByMarker(planByMarker({ home: w.home, env: w.ctx.env, platform: os, ids: [h.name] }), { home: w.home })
          if (backup === 'readable') {
            assert.ok(results.every((x) => x.result === 'undone-by-marker'), JSON.stringify(results))
            assert.equal(fs.existsSync(entry), false)
            assert.equal(read(meta), metaText)
          } else {
            const left = results.filter((x) => x.result === 'left-unreadable')
            assert.equal(left.length, 1, JSON.stringify(results))
            assert.deepEqual([fs.existsSync(entry) && read(entry), read(meta)], [onEntry, onMeta])
            assert.ok(left[0].reason.includes(entry) && left[0].reason.includes(meta), left[0].reason)
          }
        })
      }
    }
  }
}

// the receipt counts files: a file holding several of on's keys is one planned row, one changed row
test('off with the manifest gone: a file holding several door keys is one row of the plan and of the receipt', async () => {
  const { runOff } = await import('../../src/off/orchestrate.mjs')
  const { h, id, r } = DOOR_KINDS.find((x) => x.r.proxyKeys.length > 1)
  const w = world({ os: 'darwin' })
  const ctx = { ...w.ctx, env: { HOME: w.home }, dirs: dirsFor('darwin', w.home, { HOME: w.home }), harness: h.name, routeId: id, route: r }
  putIngress(w.dir, PORT)
  assert.ok(routeEntry('json-key').write(ctx, door(PORT)).ok)
  fs.rmSync(manifestPath(w.dir), { force: true })
  const off = (o) => runOff({ home: w.home, env: { HOME: w.home }, ids: [h.name], ...o, deps: quietDeps('darwin') })
  const paths = (rows) => rows.map((x) => x.path)
  const dry = (await off({})).receipt
  assert.ok(dry.planned.length > 0)
  assert.equal(new Set(paths(dry.planned)).size, dry.planned.length, JSON.stringify(dry.planned))
  const done = (await off({ yes: true })).receipt
  const changed = done.harnesses ? paths(done.changed || []) : []
  assert.equal(new Set(changed).size, changed.length, JSON.stringify(done.changed))
})

// what cannot be told is left and said (D38): a NO_PROXY the user changed while on is theirs; a door file whose only backup cannot be read is not touched
test('with the manifest gone: a NO_PROXY the user set while on stays; a door file whose backup cannot be read is left byte for byte and named', () => {
  const { h, id, r } = DOOR_KINDS.find((x) => (x.r.noProxyKeys || []).length)
  const w = world({ os: 'darwin' })
  const ctx = { ...w.ctx, env: { HOME: w.home }, dirs: dirsFor('darwin', w.home, { HOME: w.home }), harness: h.name, routeId: id, route: r }
  const file = resolveLoc(r.file, ctx)[0]
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{ "keep": 1 }\n')
  putIngress(w.dir, PORT)
  assert.ok(routeEntry('json-key').write(ctx, door(PORT)).ok)
  fs.rmSync(manifestPath(w.dir), { force: true })
  const [k] = r.noProxyKeys
  const edited = JSON.parse(read(file)); plant(edited, k, 'mine.example'); fs.writeFileSync(file, JSON.stringify(edited)) // the user's edit while on
  const plan = planByMarker({ home: w.home, env: ctx.env, platform: 'darwin', ids: [h.name] })
  assert.deepEqual(undoByMarker(plan, { home: w.home }).map((x) => x.result), ['undone-by-marker'])
  assert.equal(valueAt(parseJsonText(read(file)), k), 'mine.example')
  // again on, the backup it took made unreadable
  assert.ok(routeEntry('json-key').write({ ...ctx, manifest: (w.ctx.manifest.entries = [], w.ctx.manifest) }, door(PORT)).ok)
  for (const b of backupsOf({ home: w.home, file })) fs.writeFileSync(b, '{ not json')
  const on = read(file)
  const [res] = undoByMarker(planByMarker({ home: w.home, env: ctx.env, platform: 'darwin', ids: [h.name] }), { home: w.home })
  assert.equal(res.result, 'left-unreadable')
  assert.ok(res.backups.length > 0)
  assert.equal(read(file), on)
})
