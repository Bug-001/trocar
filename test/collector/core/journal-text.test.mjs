// test/collector/core/journal-text.test.mjs — acceptance T11 for the text entries (a dotenv block, an rc line, a dsh
// patch row) and for files trocar owns in an agent's directory (4.6 「信任入口的日志与撤销」「撤一个文件的规则」).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyJsonKey, applyTextEntry, previewTextEntry, undoEntry, newManifest, readManifest, sha256, manifestPath, writeOwnedFile, removeOwnedFile, describeEntry } from '../../../src/collector/core/trust/journal.mjs'
import { lineComment, OFF_PREFIX } from '../../../src/off/text-edit.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-jt-'))
  const dir = path.join(root, '.trocar', 'collector')
  return { root, dir, bundle: path.join(dir, 'ca', 'combined-x.pem'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const ENV = 'OPENAI_API_KEY=sk-secret-123\nSSL_CERT_FILE="/corp/ca.pem"\n'
const ROW = `- insert: [{ name: "/p/index.js" }] ${lineComment('dsh plugin')}`

test('journal text: a dotenv block — manifest has the ops and the prior path, never the file; undo is byte-identical, then already-restored', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.codex', '.env'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, ENV, { mode: 0o600 })
    const e = applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: newManifest(), harness: 'x', file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: b.bundle } } })
    const now = fs.readFileSync(file, 'utf8')
    assert.ok(now.startsWith('# >>> trocar collector >>>') && now.includes(`\n${OFF_PREFIX}SSL_CERT_FILE="/corp/ca.pem"\n`))
    const saved = readManifest(b.dir).entries[0]
    assert.deepEqual([saved.kind, saved.format, saved.existed_before, saved.pre_sha256, saved.post_sha256, saved.prior_value], ['text', 'dotenv-block', true, sha256(Buffer.from(ENV)), sha256(Buffer.from(now)), { SSL_CERT_FILE: '/corp/ca.pem' }])
    assert.ok(!fs.readFileSync(manifestPath(b.dir), 'utf8').includes('sk-secret-123'), 'no copy of the .env in the manifest')
    assert.match(describeEntry(e), /block with SSL_CERT_FILE=.*combined-x\.pem/)
    assert.equal(undoEntry(e).result, 'restored')
    assert.equal(fs.readFileSync(file, 'utf8'), ENV)
    assert.equal(undoEntry(e).result, 'already-restored')
  } finally { b.done() }
})

test('journal text: a patch file trocar created — untouched it goes with its dirs; the user added a row → only trocar\'s goes, the file stays; only comments left → it goes', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.dsh', 'cordis.patch.yml')
    const edit = { format: 'yaml-list', line: ROW }
    const e1 = applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: newManifest(), harness: 'd', file, edit })
    assert.deepEqual([fs.readFileSync(file, 'utf8'), e1.existed_before, e1.created_dirs], [`${ROW}\n`, false, [path.dirname(file)]])
    assert.equal(undoEntry(e1).result, 'restored')
    assert.ok(!fs.existsSync(path.dirname(file)), 'the file and the directory trocar created are gone')

    const e2 = applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: newManifest(), harness: 'd', file, edit })
    fs.appendFileSync(file, '- insert: [{ name: mine }]\n')
    const r2 = undoEntry(e2)
    assert.deepEqual([r2.result, r2.deleted], ['reverted-not-identical', undefined])
    assert.equal(fs.readFileSync(file, 'utf8'), '- insert: [{ name: mine }]\n', 'the user\'s row is still there, byte for byte')
    fs.rmSync(path.dirname(file), { recursive: true })

    const e3 = applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: newManifest(), harness: 'd', file, edit })
    fs.writeFileSync(file, `# a note\n${ROW}\n`)
    assert.deepEqual([undoEntry(e3).result, fs.existsSync(file)], ['reverted-not-identical', false], 'no empty patch file is left behind (dsh will not start on one)')
  } finally { b.done() }
})

test('journal text: an rc line — the user added lines before and after it; undo takes out only trocar\'s line', () => {
  const b = box()
  try {
    const rc = path.join(b.root, '.bashrc'); const before = '# rc\nexport PATH="$HOME/.kimi-code/bin:$PATH"\n'
    fs.writeFileSync(rc, before, { mode: 0o644 })
    const line = `export PATH="/s/bin:$PATH" ${lineComment('kimi shim')}`
    const e = applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: newManifest(), harness: 'k', file: rc, edit: { format: 'line', line, after: '\\.kimi-code/bin' } })
    fs.writeFileSync(rc, `top\n${fs.readFileSync(rc, 'utf8')}bottom\n`)
    assert.equal(undoEntry(e).result, 'reverted-not-identical')
    assert.equal(fs.readFileSync(rc, 'utf8'), `top\n${before}bottom\n`)
    assert.equal(fs.statSync(rc).mode & 0o777, 0o644)
    fs.writeFileSync(rc, before)
    assert.equal(undoEntry(e).result, 'already-restored')
    fs.writeFileSync(rc, `${before}x\n`)
    assert.equal(undoEntry(e).result, 'already-removed', 'the user took trocar\'s line out themselves: nothing to do, nothing changed')
    assert.equal(fs.readFileSync(rc, 'utf8'), `${before}x\n`)
  } finally { b.done() }
})

test('journal text: a crash after the intent is undone; a refused edit writes nothing; trocar text from an unlisted install is refused', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.env'); fs.writeFileSync(file, ENV)
    const m = newManifest()
    const e = applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: m, harness: 'x', file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: b.bundle } } })
    const intent = { ...e, post_sha256: null } // as if the process died before post_sha256 was saved
    assert.equal(undoEntry(intent).result, 'restored')
    assert.equal(fs.readFileSync(file, 'utf8'), ENV)
    assert.equal(undoEntry(intent).result, 'already-restored', 'died before the write: nothing to do')
    applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: newManifest(), harness: 'x', file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: b.bundle } } })
    assert.throws(() => previewTextEntry({ file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: b.bundle } } }), /already holds trocar's text/)
    const yml = path.join(b.root, 'p.yml'); fs.writeFileSync(yml, 'llm: {}\n')
    assert.throws(() => previewTextEntry({ file: yml, edit: { format: 'yaml-list', line: ROW } }), /p\.yml: the file is not a block-style YAML list/)
    assert.equal(fs.readFileSync(yml, 'utf8'), 'llm: {}\n')
  } finally { b.done() }
})

test('journal owned files: a plugin in an agent\'s directory is listed with the dirs it creates, never written over, removed with them', () => {
  const b = box()
  try {
    const plug = path.join(b.root, '.config', 'opencode', 'plugins', 'trocar-ca.js')
    const m = newManifest()
    writeOwnedFile({ phase: 'install', dir: b.dir, manifest: m, harness: 'o', role: 'plugin', file: plug, data: '// trocar collector\n', mode: 0o644, exclusive: true })
    const item = readManifest(b.dir).files[0]
    assert.deepEqual([item.role, item.mode, item.created_dirs], ['plugin', 0o644, [path.join(b.root, '.config'), path.join(b.root, '.config', 'opencode'), path.dirname(plug)]])
    assert.equal(fs.statSync(plug).mode & 0o777, 0o644)
    assert.throws(() => writeOwnedFile({ phase: 'install', dir: b.dir, manifest: m, role: 'plugin', file: plug, data: 'x', exclusive: true }), /already exists; trocar will not write over it/)
    fs.writeFileSync(path.join(path.dirname(path.dirname(plug)), 'opencode.json'), '{}') // the user's own config appears
    fs.appendFileSync(plug, '// edited\n')
    assert.deepEqual(removeOwnedFile(item), { path: plug, result: 'removed', changed: true })
    assert.ok(!fs.existsSync(path.dirname(plug)) && fs.existsSync(path.join(b.root, '.config', 'opencode', 'opencode.json')), 'only empty dirs trocar created go')
    assert.deepEqual(removeOwnedFile(item), { path: plug, result: 'already-removed' })
  } finally { b.done() }
})

// ---- the JSON form of the name family (4.6「名字族」: `alsoSet`): a member already there that would win over trocar's key gets the value too ----
for (const [platform, how] of [['win32', { fold: true }], ['darwin', { alsoSet: ['https_proxy'] }]]) {
  test(`journal json (${platform} rules): settings.json's env.https_proxy is given the door as its own json-key entry, keyed by its own spelling; off gives back the bytes`, () => {
    const home = tmpDir('trocar-jt-family-')
    const dir = path.join(home, '.trocar', 'collector')
    const file = path.join(home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(file))
    const before = '{\r\n  "env": {\r\n    "https_proxy": "http://corp.example:8080",\r\n    "Other": "1"\r\n  }\r\n}\r\n'
    fs.writeFileSync(file, before)
    const door = 'http://claude-code.settings:a1b2c3d4e5f60718@127.0.0.1:17991'
    const m = newManifest()
    applyJsonKey({ phase: 'on', dir, home, manifest: m, harness: 'claude-code', file, keys: ['env', 'HTTPS_PROXY'], value: door, ...how })
    const env = JSON.parse(fs.readFileSync(file, 'utf8')).env
    assert.deepEqual(env, { https_proxy: door, Other: '1', HTTPS_PROXY: door }, 'the member keeps its place and its spelling; only its value changed')
    assert.deepEqual(m.entries.map((e) => [e.kind, e.keys.join('.'), e.prior_value]), [['json-key', 'env.HTTPS_PROXY', null], ['json-key', 'env.https_proxy', 'http://corp.example:8080']])
    assert.equal(m.entries.every((e) => e.fold === (how.fold === true ? true : undefined)), true, 'fold is recorded when names fold')
    assert.equal(applyJsonKey({ phase: 'on', dir, home, manifest: m, harness: 'claude-code', file, keys: ['env', 'HTTPS_PROXY'], value: door, ...how }), null, 'on; on: nothing new')
    assert.equal(m.entries.length, 2)
    for (const e of [...m.entries].reverse()) assert.equal(undoEntry(e).result, 'restored')
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  })
}

test('journal json: a member that is not there is never added, a config key never folds, and a member of another object is not touched', () => {
  const home = tmpDir('trocar-jt-family-')
  const dir = path.join(home, '.trocar', 'collector')
  const file = path.join(home, 'config.json')
  fs.writeFileSync(file, '{"network": {"HttpProxy": "x"}, "env": {"https_proxy": "y"}}\n')
  const m = newManifest()
  applyJsonKey({ phase: 'on', dir, home, manifest: m, harness: 'z-code', file, keys: ['network', 'httpProxy'], value: 'http://127.0.0.1:1' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { network: { HttpProxy: 'x', httpProxy: 'http://127.0.0.1:1' }, env: { https_proxy: 'y' } })
  assert.equal(m.entries.length, 1)
})
