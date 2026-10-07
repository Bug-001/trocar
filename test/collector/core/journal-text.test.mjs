// test/collector/core/journal-text.test.mjs — acceptance T11 for the text entries (a dotenv block, an rc line, a dsh
// patch row) and for files asight owns in an agent's directory (4.6 「信任入口的日志与撤销」「撤一个文件的规则」).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyTextEntry, previewTextEntry, undoEntry, newManifest, readManifest, sha256, manifestPath, writeOwnedFile, removeOwnedFile, describeEntry } from '../../../src/collector/core/trust/journal.mjs'
import { lineComment, OFF_PREFIX } from '../../../src/off/text-edit.mjs'

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-jt-'))
  const dir = path.join(root, '.asight', 'collector')
  return { root, dir, bundle: path.join(dir, 'ca', 'combined-x.pem'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const ENV = 'OPENAI_API_KEY=sk-secret-123\nSSL_CERT_FILE="/corp/ca.pem"\n'
const ROW = `- insert: [{ name: "/p/index.js" }] ${lineComment('dsh plugin')}`

test('journal text: a dotenv block — manifest has the ops and the prior path, never the file; undo is byte-identical, then already-restored', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.codex', '.env'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, ENV, { mode: 0o600 })
    const e = applyTextEntry({ home: b.root, dir: b.dir, manifest: newManifest(), harness: 'x', file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: b.bundle } } })
    const now = fs.readFileSync(file, 'utf8')
    assert.ok(now.startsWith('# >>> asight collector >>>') && now.includes(`\n${OFF_PREFIX}SSL_CERT_FILE="/corp/ca.pem"\n`))
    const saved = readManifest(b.dir).entries[0]
    assert.deepEqual([saved.kind, saved.format, saved.existed_before, saved.pre_sha256, saved.post_sha256, saved.prior_value], ['text', 'dotenv-block', true, sha256(Buffer.from(ENV)), sha256(Buffer.from(now)), { SSL_CERT_FILE: '/corp/ca.pem' }])
    assert.ok(!fs.readFileSync(manifestPath(b.dir), 'utf8').includes('sk-secret-123'), 'no copy of the .env in the manifest')
    assert.match(describeEntry(e), /block with SSL_CERT_FILE=.*combined-x\.pem/)
    assert.equal(undoEntry(e).result, 'restored')
    assert.equal(fs.readFileSync(file, 'utf8'), ENV)
    assert.equal(undoEntry(e).result, 'already-restored')
  } finally { b.done() }
})

test('journal text: a patch file asight created — untouched it goes with its dirs; the user added a row → only asight\'s goes, the file stays; only comments left → it goes', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.dsh', 'cordis.patch.yml')
    const edit = { format: 'yaml-list', line: ROW }
    const e1 = applyTextEntry({ home: b.root, dir: b.dir, manifest: newManifest(), harness: 'd', file, edit })
    assert.deepEqual([fs.readFileSync(file, 'utf8'), e1.existed_before, e1.created_dirs], [`${ROW}\n`, false, [path.dirname(file)]])
    assert.equal(undoEntry(e1).result, 'restored')
    assert.ok(!fs.existsSync(path.dirname(file)), 'the file and the directory asight created are gone')

    const e2 = applyTextEntry({ home: b.root, dir: b.dir, manifest: newManifest(), harness: 'd', file, edit })
    fs.appendFileSync(file, '- insert: [{ name: mine }]\n')
    const r2 = undoEntry(e2)
    assert.deepEqual([r2.result, r2.deleted], ['reverted-not-identical', undefined])
    assert.equal(fs.readFileSync(file, 'utf8'), '- insert: [{ name: mine }]\n', 'the user\'s row is still there, byte for byte')
    fs.rmSync(path.dirname(file), { recursive: true })

    const e3 = applyTextEntry({ home: b.root, dir: b.dir, manifest: newManifest(), harness: 'd', file, edit })
    fs.writeFileSync(file, `# a note\n${ROW}\n`)
    assert.deepEqual([undoEntry(e3).result, fs.existsSync(file)], ['reverted-not-identical', false], 'no empty patch file is left behind (dsh will not start on one)')
  } finally { b.done() }
})

test('journal text: an rc line — the user added lines before and after it; undo takes out only asight\'s line', () => {
  const b = box()
  try {
    const rc = path.join(b.root, '.bashrc'); const before = '# rc\nexport PATH="$HOME/.kimi-code/bin:$PATH"\n'
    fs.writeFileSync(rc, before, { mode: 0o644 })
    const line = `export PATH="/s/bin:$PATH" ${lineComment('kimi shim')}`
    const e = applyTextEntry({ home: b.root, dir: b.dir, manifest: newManifest(), harness: 'k', file: rc, edit: { format: 'line', line, after: '\\.kimi-code/bin' } })
    fs.writeFileSync(rc, `top\n${fs.readFileSync(rc, 'utf8')}bottom\n`)
    assert.equal(undoEntry(e).result, 'reverted-not-identical')
    assert.equal(fs.readFileSync(rc, 'utf8'), `top\n${before}bottom\n`)
    assert.equal(fs.statSync(rc).mode & 0o777, 0o644)
    fs.writeFileSync(rc, before)
    assert.equal(undoEntry(e).result, 'already-restored')
    fs.writeFileSync(rc, `${before}x\n`)
    assert.equal(undoEntry(e).result, 'already-removed', 'the user took asight\'s line out themselves: nothing to do, nothing changed')
    assert.equal(fs.readFileSync(rc, 'utf8'), `${before}x\n`)
  } finally { b.done() }
})

test('journal text: a crash after the intent is undone; a refused edit writes nothing; asight text from an unlisted install is refused', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.env'); fs.writeFileSync(file, ENV)
    const m = newManifest()
    const e = applyTextEntry({ home: b.root, dir: b.dir, manifest: m, harness: 'x', file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: b.bundle } } })
    const intent = { ...e, post_sha256: null } // as if the process died before post_sha256 was saved
    assert.equal(undoEntry(intent).result, 'restored')
    assert.equal(fs.readFileSync(file, 'utf8'), ENV)
    assert.equal(undoEntry(intent).result, 'already-restored', 'died before the write: nothing to do')
    applyTextEntry({ home: b.root, dir: b.dir, manifest: newManifest(), harness: 'x', file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: b.bundle } } })
    assert.throws(() => previewTextEntry({ file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: b.bundle } } }), /already holds asight's text/)
    const yml = path.join(b.root, 'p.yml'); fs.writeFileSync(yml, 'llm: {}\n')
    assert.throws(() => previewTextEntry({ file: yml, edit: { format: 'yaml-list', line: ROW } }), /p\.yml: the file is not a block-style YAML list/)
    assert.equal(fs.readFileSync(yml, 'utf8'), 'llm: {}\n')
  } finally { b.done() }
})

test('journal owned files: a plugin in an agent\'s directory is listed with the dirs it creates, never written over, removed with them', () => {
  const b = box()
  try {
    const plug = path.join(b.root, '.config', 'opencode', 'plugins', 'asight-ca.js')
    const m = newManifest()
    writeOwnedFile({ dir: b.dir, manifest: m, harness: 'o', role: 'plugin', file: plug, data: '// asight collector\n', mode: 0o644, exclusive: true })
    const item = readManifest(b.dir).files[0]
    assert.deepEqual([item.role, item.mode, item.created_dirs], ['plugin', 0o644, [path.join(b.root, '.config'), path.join(b.root, '.config', 'opencode'), path.dirname(plug)]])
    assert.equal(fs.statSync(plug).mode & 0o777, 0o644)
    assert.throws(() => writeOwnedFile({ dir: b.dir, manifest: m, role: 'plugin', file: plug, data: 'x', exclusive: true }), /already exists; asight will not write over it/)
    fs.writeFileSync(path.join(path.dirname(path.dirname(plug)), 'opencode.json'), '{}') // the user's own config appears
    fs.appendFileSync(plug, '// edited\n')
    assert.deepEqual(removeOwnedFile(item), { path: plug, result: 'removed', changed: true })
    assert.ok(!fs.existsSync(path.dirname(plug)) && fs.existsSync(path.join(b.root, '.config', 'opencode', 'opencode.json')), 'only empty dirs asight created go')
    assert.deepEqual(removeOwnedFile(item), { path: plug, result: 'already-removed' })
  } finally { b.done() }
})
