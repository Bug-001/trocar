// test/off/marker.test.mjs — src/off/marker.mjs (RFC 1.6 R3 「按标记撤销」, 4.6 §安装清单与卸载): undoing asight's changes with no manifest, by asight's own
// marks — sentinel blocks and lines, JSON values that point under ~/.asight, the plugins and shims asight wrote — at the places each harness keeps its entry.
// Every case installs all seven harnesses through the real installCollector into a sandbox HOME, then deletes the manifest and works from the HOME alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installCollector } from '../../src/collector/install.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { ANONYMOUS_MODULE_MANIFEST } from '../../src/collector/harness/_plugins.mjs'
import { HARNESS_IDS } from '../../src/cli/harness-names.mjs'
import { planByMarker, undoByMarker, MARKER_PATHS } from '../../src/off/marker.mjs'
import { backupsOf, writeBackup } from '../../src/off/backup.mjs'
import { manifestPath } from '../../src/off/manifest.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sevenHomes } from './fixtures/seven-homes.mjs'

const roots = { node: [createCa({ commonName: 'marker root' }).certPem], osText: '' }
const read = (f) => fs.readFileSync(f, 'utf8')

// all seven installed over a HOME where Claude Code already had its own NODE_EXTRA_CA_CERTS and Hermes its own SSL_CERT_FILE (both replaced / put out of
// effect by asight); the manifest is then gone
async function lostManifest() {
  const home = tmpDir('asight-marker-')
  const sh = sevenHomes(home)
  const cc = sh.files['claude-code'][0], hermes = sh.files.hermes[0]
  fs.writeFileSync(cc, `{\n  "model": "x",\n  "env": {\n    "NODE_EXTRA_CA_CERTS": ${JSON.stringify(sh.corp)}\n  }\n}\n`)
  fs.writeFileSync(hermes, `OPENAI_API_KEY=sk-test-hermes\nSSL_CERT_FILE=${sh.corp}\n`)
  const original = Object.fromEntries(Object.values(sh.files).flat().map((f) => [f, read(f)]))
  await installCollector({ home, env: { HOME: home }, osName: 'linux', harnesses: await loadHarnesses(), freePort: async () => 47011, scan: async () => [], roots })
  const dir = path.join(home, '.asight', 'collector')
  fs.rmSync(manifestPath(dir))
  return { home, sh, original, dir, rel: (p) => path.relative(home, p) }
}

test('planByMarker finds, with no manifest, every change of the seven harnesses by asight\'s own marks, and plans the values and blocks before the lines before the plugins', async () => {
  const s = await lostManifest()
  const plan = planByMarker({ home: s.home })
  assert.deepEqual(plan.map((p) => [p.harness, s.rel(p.path), p.how]), [
    ['claude-code', '.claude/settings.json', 'json-value'], ['codex', '.codex/.env', 'block'], ['hermes', '.hermes/.env', 'block'], ['z-code', '.zcode/cli/config.json', 'json-value'],
    ['deepseek-dsh', '.dsh/cordis.patch.yml', 'line'], ['kimi-code', '.bashrc', 'line'],
    ['opencode', '.config/opencode/plugins/asight-ca.js', 'owned-file'], ['deepseek-dsh', '.asight/collector/plugins/dsh/index.js', 'owned-file'], ['deepseek-dsh', '.asight/collector/plugins/dsh/package.json', 'owned-file'], ['kimi-code', '.asight/collector/bin/kimi', 'owned-file'],
  ])
  assert.deepEqual(plan.find((p) => p.harness === 'hermes').detail, { blocks: 1, commented: 1 }, 'the block, and the line of the user it put out of effect')
  assert.deepEqual(planByMarker({ home: s.home, ids: ['codex', 'kimi-code'] }).map((p) => [p.harness, p.how]), [['codex', 'block'], ['kimi-code', 'line'], ['kimi-code', 'owned-file']])
  assert.deepEqual(Object.keys(MARKER_PATHS).sort(), [...HARNESS_IDS].sort(), 'every harness has places to look')
})

test('undoByMarker takes asight out of each file and nothing else: blocks and lines go and the commented user line comes back byte for byte; a replaced JSON value comes back from the newest backup, that key only; plugins and the shim go', async () => {
  const s = await lostManifest()
  const cc = s.sh.files['claude-code'][0]
  const doc = JSON.parse(read(cc)); doc.theme = 'dark'; fs.writeFileSync(cc, JSON.stringify(doc, null, 2) + '\n') // the user edits the file after install (CC rewrites its settings)
  const results = undoByMarker(planByMarker({ home: s.home }), { home: s.home })
  assert.deepEqual(results.map((r) => r.result), Array(10).fill('undone-by-marker'), 'the code `off` records and the receipt shows')
  const by = (h, how) => results.find((r) => r.harness === h && r.how === how)
  assert.equal(read(s.sh.files.codex[0]), s.original[s.sh.files.codex[0]], 'a block: byte for byte')
  assert.equal(read(s.sh.files.hermes[0]), s.original[s.sh.files.hermes[0]], 'the block is out and the user\'s own SSL_CERT_FILE line is back as it was')
  assert.equal(by('hermes', 'block').restored, 1)
  assert.equal(read(s.sh.files['kimi-code'][0]), s.original[s.sh.files['kimi-code'][0]], 'a line')
  assert.deepEqual(JSON.parse(read(cc)), { model: 'x', env: { NODE_EXTRA_CA_CERTS: s.sh.corp }, theme: 'dark' }, 'the user\'s value is back from the backup and the edit made since stays: one key, never the whole file')
  assert.equal(by('claude-code', 'json-value').restored_from, backupsOf({ home: s.home, file: cc }).at(-1))
  assert.deepEqual(JSON.parse(read(s.sh.files['z-code'][0])), { model: 'lab/m', network: {} }, 'a key asight added, with no backup of a value, just goes')
  assert.ok(!fs.existsSync(s.sh.files['deepseek-dsh'][0]), 'the dsh patch file held only asight\'s row (it was `[]`): dsh does not start on an empty file, so it is removed')
  for (const gone of ['.config/opencode/plugins', '.asight/collector/bin', '.asight/collector/plugins']) assert.ok(!fs.existsSync(path.join(s.home, gone)), `${gone} is gone, the directory too`)
  assert.ok(fs.existsSync(path.join(s.home, '.asight', 'collector', 'ca', 'asight-ca.pem')), 'the CA is asight\'s, not an entry: marker undo leaves it for uninstall')
  assert.deepEqual(planByMarker({ home: s.home }), [], 'nothing of asight\'s is left to find')
  assert.deepEqual(undoByMarker(planByMarker({ home: s.home }), { home: s.home }), [], 'and a second run does nothing')
})

test('what is not asight\'s is not touched: a plugin file of the user\'s, a PATH line without the sentinel comment, a JSON value that does not point under ~/.asight, a conda block', async () => {
  const home = tmpDir('asight-marker-own-')
  const put = (rel, t) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return f }
  const plugin = put('.config/opencode/plugins/asight-ca.js', '// mine, not asight\'s\n')
  const rc = put('.bashrc', '# >>> conda initialize >>>\nexport PATH="/opt/conda/bin:$PATH"\n# <<< conda initialize <<<\nexport PATH="/home/u/.asight/collector/bin:$PATH"\n') // looks like the shim line, has no sentinel comment
  const cc = put('.claude/settings.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: '/corp/relay.pem' } }))
  const env = put('.codex/.env', `# >>> something else >>>\nSSL_CERT_FILE=${path.join(home, '.asight', 'collector', 'ca', 'x.pem')}\n`)
  const before = [plugin, rc, cc, env].map(read)
  assert.deepEqual(planByMarker({ home }), [])
  const forged = [{ harness: 'opencode', path: plugin, how: 'owned-file', detail: {} }, { harness: 'kimi-code', path: rc, how: 'line', detail: {} }, { harness: 'claude-code', path: cc, how: 'json-value', detail: { keys: ['env', 'NODE_EXTRA_CA_CERTS'] } }]
  assert.deepEqual(undoByMarker(forged, { home }).map((r) => r.result), ['already-clean', 'already-clean', 'already-clean'], 'a plan is never trusted over the file: the mark is looked for again')
  assert.deepEqual([plugin, rc, cc, env].map(read), before)
})

test('a replaced JSON value comes back from the NEWEST backup of that file; a backup holding no such key removes it; a file that no longer parses is left as it is', async () => {
  const home = tmpDir('asight-marker-json-')
  const file = path.join(home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(file), { recursive: true })
  const ours = path.join(home, '.asight', 'collector', 'ca', 'asight-ca.pem')
  let n = 0 // each backup a second after the one before: the newest sorts last
  const bk = (v) => writeBackup({ home, file, data: Buffer.from(JSON.stringify({ env: v === undefined ? {} : { NODE_EXTRA_CA_CERTS: v }, model: 'old' })), now: new Date(Date.UTC(2026, 9, 7, 1, 0, ++n)) })
  bk('/corp/first.pem'); bk('/corp/second.pem')
  fs.writeFileSync(file, `{ "env": { "NODE_EXTRA_CA_CERTS": ${JSON.stringify(ours)} }, "model": "edited by the user" }`)
  const [r] = undoByMarker(planByMarker({ home }), { home })
  assert.deepEqual([r.result, r.value], ['undone-by-marker', '/corp/second.pem'])
  assert.equal(read(file), '{ "env": { "NODE_EXTRA_CA_CERTS": "/corp/second.pem" }, "model": "edited by the user" }', 'a text splice of one value: every other byte of the file as it is')
  // the newest backup has no such key: the key goes
  bk(undefined)
  fs.writeFileSync(file, `{ "env": { "NODE_EXTRA_CA_CERTS": ${JSON.stringify(ours)}, "A": "1" } }`)
  const [r2] = undoByMarker(planByMarker({ home }), { home })
  assert.deepEqual([r2.result, r2.removed, JSON.parse(read(file))], ['undone-by-marker', true, { env: { A: '1' } }])
  // a file that does not parse: left
  const broken = `{ "env": { "NODE_EXTRA_CA_CERTS": ${JSON.stringify(ours)} } trailing`
  fs.writeFileSync(file, broken)
  assert.deepEqual(planByMarker({ home }), [], 'it cannot be read as JSON, so no value of it is found')
  assert.deepEqual(undoByMarker([{ harness: 'claude-code', path: file, how: 'json-value', detail: { keys: ['env', 'NODE_EXTRA_CA_CERTS'] } }], { home }).map((x) => x.result), ['left-unparsable'])
  assert.equal(read(file), broken)
})

test('a block whose close line the user deleted still goes (its variables under ~/.asight with it), a dsh patch file with the user\'s rows keeps them, and the plugin manifest text is the collector\'s own', async () => {
  const home = tmpDir('asight-marker-block-')
  const root = path.join(home, '.asight')
  const env = path.join(home, '.codex', '.env'); fs.mkdirSync(path.dirname(env), { recursive: true })
  fs.writeFileSync(env, `# >>> asight collector >>> written by \`asight collector install\`; \`asight collector uninstall\` removes this block\nSSL_CERT_FILE=${root}/collector/ca/combined-codex.pem\nOPENAI_API_KEY=sk-1\n#asight-collector-off# SSL_CERT_FILE=/corp/own.pem\n`)
  const patch = path.join(home, '.dsh', 'cordis.patch.yml'); fs.mkdirSync(path.dirname(patch), { recursive: true })
  fs.writeFileSync(patch, `- set: {a: 1}\n- insert: [{ name: "${root}/collector/plugins/dsh/index.js" }] # asight collector: loads asight's CA trust plugin\n- insert: [{ name: mine }]\n`)
  assert.deepEqual(undoByMarker(planByMarker({ home }), { home }).map((r) => r.result), ['undone-by-marker', 'undone-by-marker'])
  assert.equal(read(env), 'OPENAI_API_KEY=sk-1\nSSL_CERT_FILE=/corp/own.pem\n', 'the open line and the variable under ~/.asight are out, the user\'s API key stays, the commented line is back')
  assert.equal(read(patch), '- set: {a: 1}\n- insert: [{ name: mine }]\n')
  assert.equal(ANONYMOUS_MODULE_MANIFEST, '{"type":"module"}\n', 'src/off keeps its own copy of asight\'s plugin manifest text; this is what keeps it equal')
  assert.ok(MARKER_PATHS['deepseek-dsh'].some((p) => p.exact === ANONYMOUS_MODULE_MANIFEST))
})

test('D48② with no manifest: a key the user set while on keeps the user\'s value — its old line stays out of effect and is reported (prior_left); a key the user did not set comes back, also on line 1 after a mark and when an editor indented the prefix', async () => {
  const { OFF_PREFIX, BLOCK_BEGIN, BLOCK_END } = await import('../../src/off/text-edit.mjs')
  const home = tmpDir('asight-marker-d48-')
  const f = path.join(home, '.codex', '.env')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const ca = path.join(home, '.asight', 'collector', 'ca', 'combined-codex.pem')
  const block = `${BLOCK_BEGIN}\nSSL_CERT_FILE=${ca}\n${BLOCK_END}\n`
  // the user set SSL_CERT_FILE again while on (below asight's block); HTTPS_PROXY and NO_PROXY they left alone
  fs.writeFileSync(f, `﻿${OFF_PREFIX}HTTPS_PROXY=http://corp.example:8080\n${block}SSL_CERT_FILE=/mine/ca.pem\n${OFF_PREFIX}SSL_CERT_FILE=/corp/ca.pem\n  ${OFF_PREFIX}NO_PROXY=localhost\nOPENAI_API_KEY=sk-x\n`)
  const [r] = undoByMarker(planByMarker({ home, ids: ['codex'] }), { home })
  assert.equal(r.result, 'undone-by-marker')
  const out = read(f)
  assert.equal(out, `﻿HTTPS_PROXY=http://corp.example:8080\nSSL_CERT_FILE=/mine/ca.pem\n${OFF_PREFIX}SSL_CERT_FILE=/corp/ca.pem\n  NO_PROXY=localhost\nOPENAI_API_KEY=sk-x\n`, 'the block goes; the user\'s new value wins, the old line stays out of effect; the others come back')
  assert.equal(r.restored, 2, 'the lines that came back are counted, line 1 after the mark among them')
  assert.deepEqual(r.prior_left, [{ key: 'SSL_CERT_FILE', line: 3 }], 'the old line left out of effect is reported by line, as the journal path reports it')
})
