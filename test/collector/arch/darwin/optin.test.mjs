// test/collector/arch/darwin/optin.test.mjs — the darwin opt-in writer (RFC 4.9 §2.4 · §6.3; the flip checklist ④, the win32 twin's Task 14): the
// catalog over the REAL harness data, the rc PATH item's apply (the shim + the sentinel line in the zsh rc files) and its reference-counted undo.
// Nothing here runs a real OS tool or touches a keychain: HOME is a temp dir, the CA a generated one, every read-back reads files. The line's
// twin copies (arch/darwin/optin.mjs rcLineOf and src/off/darwin-optin.mjs's) are held equal here — the standalone cannot import the arch module,
// so the copies are the contract, the way test/off/win32-optin.test.mjs holds the registry argv twins.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { loadArch } from '../../../../src/collector/arch/index.mjs'
import { planOptIns, optinFormsOf, applyOptIn, rcLineOf, OPTIN_ITEMS } from '../../../../src/collector/arch/darwin/optin.mjs'
import { groupsOf } from '../../../../src/collector/arch/darwin/route-plan.mjs'
import { DARWIN_UNDO_BY_KIND, undoDarwinOptIns, rcLineOf as rcLineOfOff } from '../../../../src/off/darwin-optin.mjs'
import { KNOWN_KINDS } from '../../../../src/off/manifest.mjs'
import { readManifest, saveManifest, newManifest } from '../../../../src/off/manifest.mjs'
import { certBlocks } from '../../../../src/off/pem.mjs'
import { createCa } from '../../../../src/collector/core/tls/ca.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const descs = await loadHarnesses()
const darwin = await loadArch('darwin')
const byName = (n) => descs.find((d) => d.name === n)
const GROUP_PORT = 17992
const LISTENER_TOKEN = 'b'.repeat(32)
const KERNEL_URL = `http://kimi-code.cli:${LISTENER_TOKEN}@127.0.0.1:${GROUP_PORT}`

// the catalog over the real harness data: the three items 4.9 §2.3's table declares, one row per (form, item), with the command a user types
test('the catalog: the darwin harness data\'s three opt-in items surface as plan rows, one per form, with scope and command', () => {
  const rows = planOptIns({ groups: groupsOf(descs), optIns: ['kimi-code.cli'] })
  const of = (form, item) => rows.find((r) => r.form === form && r.item === item)
  assert.ok(rows.length >= 3, `the three declared items: ${rows.map((r) => `${r.form}/${r.item}`).join(', ')}`)
  for (const r of rows) {
    assert.equal(r.scope, 'user', `${r.form}/${r.item}: every darwin item of v1 is user-level (4.9 §2.4)`)
    assert.equal(r.admin, false)
    assert.ok(OPTIN_ITEMS[r.item] && r.kinds.length === 1 && r.impact && r.impact.length > 20, `${r.form}/${r.item}: the row says what it is`)
    assert.equal(r.command, `asight on ${r.harness} --opt-in ${r.form}`)
  }
  assert.deepEqual([of('kimi-code.cli', 'user-path-shim').chosen, of('opencode.cli', 'user-path-shim').chosen, of('claude-code.desktop', 'keychain-login').chosen], [true, false, false], 'the named form is chosen')
  assert.equal(of('kimi-code.cli', 'user-path-shim').kinds[0], 'optin-rc-path')
  assert.equal(of('claude-code.desktop', 'keychain-login').kinds[0], 'optin-keychain-cert')
  // a ledger entry makes an item done, never re-offered as needed
  const m = newManifest(new Date())
  m.entries.push({ kind: 'optin-rc-path', harness: 'kimi-code', form: 'kimi-code.cli', item: 'user-path-shim', scope: 'user', path: '/x', confirmed: true })
  assert.equal(planOptIns({ groups: groupsOf([byName('kimi-code')]), manifest: m }).find((r) => r.form === 'kimi-code.cli').state, 'done')
  assert.deepEqual(optinFormsOf(groupsOf(descs)).sort(), ['claude-code.desktop', 'kimi-code.cli', 'opencode.cli'])
  // the arch object exposes the same hooks the CLI reaches (forms / plan / apply — the flip checklist ④'s seam)
  assert.deepEqual(darwin.optIn.forms({ harnesses: descs }).sort(), ['claude-code.desktop', 'kimi-code.cli', 'opencode.cli'])
  const viaArch = darwin.optIn.plan({ harnesses: descs, optIn: [] })
  assert.equal(viaArch.length, rows.length)
})

// one sandbox the apply runs in: the native kimi binary, two of the four zsh rc files (.zshrc holds the Kimi installer's own PATH line,
// .zshenv does not — the two anchors), the collector's ingress.json and CA, and the login keychain file the CC-Desktop item needs
function world({ commands = ['kimi'] } = {}) {
  const home = tmpDir('asight-darwin-optin-')
  const dir = path.join(home, '.asight', 'collector')
  fs.mkdirSync(path.join(dir, 'ca'), { recursive: true })
  const ca = createCa({ commonName: 'optin test CA' })
  fs.writeFileSync(path.join(dir, 'ca', 'asight-ca.pem'), ca.certPem)
  fs.writeFileSync(path.join(dir, 'ingress.json'), JSON.stringify({ enginePort: 17990, groupPorts: { 'kimi-code.cli': GROUP_PORT, 'opencode.cli': GROUP_PORT + 1 }, ingressToken: 'a'.repeat(32), listenerToken: LISTENER_TOKEN }))
  fs.mkdirSync(path.join(home, '.kimi-code', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kimi-code', 'bin', 'kimi'), '#!/bin/sh\nexec the-real-kimi "$@"\n', { mode: 0o755 })
  fs.mkdirSync(path.join(home, '.opencode', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(home, '.opencode', 'bin', 'opencode'), '#!/bin/sh\nexec the-real-opencode "$@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(home, '.zshrc'), 'export PATH="$HOME/.kimi-code/bin:$PATH"\nalias ll=ls\n')
  fs.writeFileSync(path.join(home, '.zshenv'), 'export EDITOR=vim\n')
  fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'), '')
  const manifest = newManifest(new Date())
  const wrote = { notes: [], failures: [], states: [] }
  const apply = async (harness, form, item, deps = {}) => {
    const row = { form, harness, item, scope: 'user' }
    const out = await applyOptIn({
      row, groups: groupsOf([byName(harness)]), manifest, dir, home, env: { HOME: home }, fs,
      now: () => new Date('2026-10-11T00:00:00Z'),
      save: () => saveManifest(dir, manifest, fs),
      note: (rec) => wrote.notes.push(rec), failure: (rec) => wrote.failures.push(rec), state: (rec) => wrote.states.push(rec),
      deps,
    })
    return { out, entry: manifest.entries.at(-1) }
  }
  return { home, dir, ca, manifest, wrote, apply }
}

test('the rc-path apply: the shim carries the kernel listener and the CA; the line goes in every rc file that exists — after the installer\'s own PATH line where there is one', async () => {
  const w = world()
  const { out, entry } = await w.apply('kimi-code', 'kimi-code.cli', 'user-path-shim')
  assert.deepEqual([out.state, out.reason], ['done', undefined], JSON.stringify(out))
  const shim = path.join(w.dir, 'bin', 'kimi')
  const text = fs.readFileSync(shim, 'utf8')
  assert.match(text, /HTTPS_PROXY='http:\/\/kimi-code\.cli:b{32}@127\.0\.0\.1:17992'/, 'the kernel listener, quoted for the shell')
  assert.match(text, new RegExp(`NODE_EXTRA_CA_CERTS='${path.join(w.dir, 'ca', 'asight-ca.pem')}'`), 'the CA file Node reads')
  assert.match(text, new RegExp(`'${path.join(w.home, '.kimi-code', 'bin', 'kimi')}'`), 'the real binary it forwards to')
  assert.ok(fs.statSync(shim).mode & 0o111, 'executable')
  const zshrc = fs.readFileSync(path.join(w.home, '.zshrc'), 'utf8')
  const line = rcLineOf(path.join(w.dir, 'bin'))
  assert.ok(zshrc.includes(line), 'the sentinel line is in')
  assert.ok(zshrc.indexOf(line) > zshrc.indexOf('.kimi-code/bin'), 'after the installer\'s own PATH line — the later export wins')
  assert.ok(fs.readFileSync(path.join(w.home, '.zshenv'), 'utf8').endsWith(`${line}\n`), 'a file with no installer line gets it at the end')
  // the ledger: one entry, scope user, the backups and the post sha of every file it changed
  assert.deepEqual([entry.kind, entry.scope, entry.form, entry.item, entry.confirmed], ['optin-rc-path', 'user', 'kimi-code.cli', 'user-path-shim', true])
  assert.deepEqual(entry.values.rcs.map((r) => [path.basename(r.file), r.lined === 'already' || !!r.backup]), [['.zshrc', true], ['.zshenv', true]])
  assert.deepEqual(w.wrote.states, [{ event: 'optin-applied', where: 'optin', form: 'kimi-code.cli', item: 'user-path-shim', scope: 'user' }])
  assert.ok(KNOWN_KINDS.includes('optin-rc-path'), 'the manifest reader knows the kind (the undo\'s gate)')
})

test('the rc-path apply: a second command over the same rc files adds no second line (the line is the shared item), and its undo leaves the first\'s alone', async () => {
  const w = world({ commands: ['kimi', 'opencode'] })
  await w.apply('kimi-code', 'kimi-code.cli', 'user-path-shim')
  const { out, entry } = await w.apply('opencode', 'opencode.cli', 'user-path-shim')
  assert.equal(out.state, 'done')
  const zshrc = fs.readFileSync(path.join(w.home, '.zshrc'), 'utf8')
  const line = rcLineOf(path.join(w.dir, 'bin'))
  assert.equal(zshrc.split(line).length - 1, 1, 'ONE line, not one per command')
  assert.ok(entry.values.rcs.every((r) => r.lined === 'already'), 'the second entry wrote no line of its own — the shared one counts for it')
  assert.ok(fs.existsSync(path.join(w.dir, 'bin', 'opencode')), 'but its own shim is in')
  // the reference count: kimi's undo takes kimi's shim only, the lines and the directory stay (opencode still resolves through them)
  const before = fs.readFileSync(path.join(w.home, '.zshrc'), 'utf8')
  const r1 = await undoDarwinOptIns({ manifest: w.manifest, ids: ['kimi-code'], fs, home: w.home })
  assert.equal(r1.results[0].result, 'undone')
  assert.match(r1.results[0].reason, /the PATH lines and the shim directory stay/)
  assert.ok(!fs.existsSync(path.join(w.dir, 'bin', 'kimi')) && fs.existsSync(path.join(w.dir, 'bin', 'opencode')))
  assert.equal(fs.readFileSync(path.join(w.home, '.zshrc'), 'utf8'), before, 'not a byte of the rc files moved')
  // the last shim: the lines go, the directory goes, the rc files are byte for byte what they were before the line (no user edits)
  const zshrcBefore = 'export PATH="$HOME/.kimi-code/bin:$PATH"\nalias ll=ls\n'
  const zshenvBefore = 'export EDITOR=vim\n'
  const r2 = await undoDarwinOptIns({ manifest: w.manifest, ids: ['opencode'], fs, home: w.home })
  assert.equal(r2.results[0].result, 'undone', JSON.stringify(r2))
  assert.deepEqual([fs.readFileSync(path.join(w.home, '.zshrc'), 'utf8'), fs.readFileSync(path.join(w.home, '.zshenv'), 'utf8')], [zshrcBefore, zshenvBefore], 'byte for byte, via the backups (V56)')
  assert.ok(!fs.existsSync(path.join(w.dir, 'bin')), 'the shim directory went with the last shim')
})

test('the rc-path undo: a file the user edited since keeps their edits — only asight\'s line goes (D28)', async () => {
  const w = world()
  await w.apply('kimi-code', 'kimi-code.cli', 'user-path-shim')
  const file = path.join(w.home, '.zshenv')
  fs.writeFileSync(file, `# my own note\n${fs.readFileSync(file, 'utf8')}`)
  const r = await undoDarwinOptIns({ manifest: w.manifest, ids: ['kimi-code'], fs, home: w.home })
  assert.equal(r.results[0].result, 'undone')
  assert.equal(fs.readFileSync(file, 'utf8'), '# my own note\nexport EDITOR=vim\n', 'the note stays, the line goes, nothing else moved')
})

test('the rc-path apply refuses what it must, writing nothing: no native binary', async () => {
  const w = world()
  fs.rmSync(path.join(w.home, '.kimi-code', 'bin', 'kimi'))
  const a = await w.apply('kimi-code', 'kimi-code.cli', 'user-path-shim')
  assert.deepEqual([a.out.state, a.entry], ["failed", undefined], JSON.stringify(a.out))
  assert.match(a.out.reason, /not the native install/)
  assert.ok(!fs.existsSync(path.join(w.dir, 'bin')), 'no shim was written')
  assert.equal(fs.readFileSync(path.join(w.home, '.zshrc'), 'utf8'), 'export PATH="$HOME/.kimi-code/bin:$PATH"\nalias ll=ls\n', 'no rc file was touched')
  assert.ok(w.wrote.failures.some((f) => f.code === 'optin-failed'), 'the failure is recorded, not silent (D38)')
})

// the keychain item's recording runner: `security` argv in, what the tool would print out. Stateful the way the keychain is: after
// remove-trusted-cert the dump no longer holds ours (the re-check is honest), before it does. `removeSaw` captures what the temp file
// held at the moment of the call (the undo's finally deletes it right after).
function securityRunner({ caPem, otherPem = '', addExit = 0, addErr = '', removeExit = 0, deleteExit = 0, readBackHas = true } = {}) {
  const calls = []
  let removeSaw = null
  let trusted = true
  const run = (file, args) => {
    calls.push([file, ...args])
    if (file !== 'security') return { status: 127, stdout: '', stderr: `no such tool ${file}` }
    const a = args.join(' ')
    if (a.startsWith('add-trusted-cert')) return { status: addExit, stdout: '', stderr: addErr }
    if (a.startsWith('find-certificate')) return { status: 0, stdout: (trusted && readBackHas ? caPem : '') + otherPem, stderr: '' }
    if (a.startsWith('remove-trusted-cert')) { trusted = false; try { removeSaw = fs.readFileSync(args[1], 'utf8') } catch { removeSaw = null } return { status: removeExit, stdout: '', stderr: '' } }
    if (a.startsWith('delete-certificate')) return { status: deleteExit, stdout: '', stderr: '' }
    return { status: 1, stdout: '', stderr: `unexpected security call: ${a}` }
  }
  return { run, calls, removeSaw: () => removeSaw }
}

test('the keychain apply: the user-domain add-trusted-cert (never -r trustRoot), the read-back by SHA-256, the ledger keyed on the fingerprint', async () => {
  const w = world()
  const other = createCa({ commonName: 'an unrelated keychain certificate' })
  const r = securityRunner({ caPem: w.ca.certPem, otherPem: other.certPem })
  const { out, entry } = await w.apply('claude-code', 'claude-code.desktop', 'keychain-login', { run: r.run })
  assert.deepEqual([out.state, out.reason], ['done', undefined], JSON.stringify(out))
  const add = r.calls.find((c) => c[1] === 'add-trusted-cert')
  assert.ok(add, 'add-trusted-cert ran')
  assert.deepEqual(add.slice(0, 2), ['security', 'add-trusted-cert'])
  assert.equal(add[2], '-k', 'the user-domain form: -k <login keychain>')
  assert.equal(add[3], path.join(w.home, 'Library', 'Keychains', 'login.keychain-db'))
  assert.equal(add[4], path.join(w.dir, 'ca', 'asight-ca.pem'))
  assert.ok(!r.calls.some((c) => c.includes('-r') || c.includes('trustRoot')), 'NEVER the old MITM\'s forbidden form (1.6:279)')
  const find = r.calls.find((c) => c[1] === 'find-certificate')
  assert.deepEqual([find[2], find[3]], ['-a', '-p'], 'the read-back dumps every certificate as PEM')
  // the ledger: the fingerprint (not the common name) is the identity, the entry is confirmed by the read-back
  const fp = new crypto.X509Certificate(w.ca.certPem).fingerprint256
  assert.deepEqual([entry.kind, entry.scope, entry.form, entry.item, entry.confirmed], ['optin-keychain-cert', 'user', 'claude-code.desktop', 'keychain-login', true])
  assert.deepEqual(entry.values, { keychain: path.join(w.home, 'Library', 'Keychains', 'login.keychain-db'), fp256: fp, certFile: path.join(w.dir, 'ca', 'asight-ca.pem') })
  assert.equal(entry.path, `login-keychain:${fp}`)
  assert.ok(w.wrote.states.some((s) => s.event === 'optin-applied' && s.item === 'keychain-login'))
  assert.ok(!fs.existsSync(path.join(w.home, '.asight', 'collector', 'optin-tmp-cert.pem')), 'the apply wrote no temp file (the undo\'s own file)')
})

test('the keychain apply: a declined authorization dialog is the user\'s own no (wording, exit, the entry stays undoable); a read-back miss fails too', async () => {
  const w = world()
  const decline = securityRunner({ caPem: w.ca.certPem, addExit: 51, addErr: 'security: SecKeychainAddAuthorization() failed' })
  const a = await w.apply('claude-code', 'claude-code.desktop', 'keychain-login', { run: decline.run })
  assert.equal(a.out.state, 'failed')
  assert.match(a.out.reason, /authorization dialog .* was declined.*your own no, not a step waiting for an administrator/s)
  assert.equal(a.entry.confirmed, false, 'the entry stays in the ledger — what ran is undoable, never a mystery')
  assert.ok(w.wrote.failures.some((f) => f.code === 'optin-failed' && f.item === 'keychain-login'), 'the failure is recorded (D38)')
  assert.ok(!decline.calls.some((c) => c[1] === 'find-certificate'), 'no read-back after a declined import')
  // the import runs, the read-back does not find it (a dump without ours): failed, not done
  const w2 = world()
  const miss = securityRunner({ caPem: w2.ca.certPem, readBackHas: false })
  const b = await w2.apply('claude-code', 'claude-code.desktop', 'keychain-login', { run: miss.run })
  assert.equal(b.out.state, 'failed')
  assert.match(b.out.reason, /the read-back did not find the certificate/)
  assert.equal(b.entry.confirmed, false)
})

test('the keychain undo: by fingerprint out and back — remove-trusted-cert carries the certificate block itself, delete-certificate -Z its SHA-1, the temp file goes', async () => {
  const w = world()
  const r = securityRunner({ caPem: w.ca.certPem })
  const { out } = await w.apply('claude-code', 'claude-code.desktop', 'keychain-login', { run: r.run })
  assert.equal(out.state, 'done')
  const undoRun = securityRunner({ caPem: w.ca.certPem })
  const u = await undoDarwinOptIns({ manifest: w.manifest, ids: ['claude-code'], exec: undoRun.run, env: { HOME: w.home }, fs, home: w.home })
  assert.deepEqual([u.results[0].kind, u.results[0].result], ['optin-keychain-cert', 'undone'], JSON.stringify(u))
  assert.equal(u.unknown.length, 0)
  const remove = undoRun.calls.find((c) => c[1] === 'remove-trusted-cert')
  const tmpFile = remove[2]
  assert.ok(/optin-tmp-cert\.pem$/.test(tmpFile), `the trust setting is taken away with the certificate block itself (${tmpFile})`)
  assert.equal(undoRun.removeSaw(), certBlocks(w.ca.certPem)[0].pem, 'the temp file held exactly the certificate block the keychain was dumped as (byte for byte, the block pem.mjs carves)')
  assert.ok(!fs.existsSync(tmpFile), 'the temp file went with the finally')
  const del = undoRun.calls.find((c) => c[1] === 'delete-certificate')
  const sha1 = crypto.createHash('sha1').update(new crypto.X509Certificate(w.ca.certPem).raw).digest('hex').toUpperCase()
  assert.deepEqual([del[2], del[3]], ['-Z', sha1], 'the certificate deleted by its SHA-1, the form security\'s -Z takes')
  assert.equal(del[4], path.join(w.home, 'Library', 'Keychains', 'login.keychain-db'))
  assert.ok(undoRun.calls.filter((c) => c[1] === 'find-certificate').length >= 2, 'found by fingerprint before, re-checked after')
  // a second undo: the certificate is gone from the keychain — absent, said, nothing guessed
  const again = securityRunner({ caPem: '' })
  const u2 = await undoDarwinOptIns({ manifest: w.manifest, ids: ['claude-code'], exec: again.run, env: { HOME: w.home }, fs, home: w.home })
  assert.equal(u2.results[0].result, 'absent')
})

// the inline-copy contract: the arch side's line and the off side's are one text, and every kind the apply can produce has an undo
test('the copies: the off side\'s rcLineOf is the arch side\'s, and DARWIN_UNDO_BY_KIND covers exactly the kinds the apply produces', () => {
  assert.equal(rcLineOfOff('/x/bin'), rcLineOf('/x/bin'), 'the line the apply writes is the line the undo takes out')
  const producible = Object.values(OPTIN_ITEMS).flatMap((d) => d.parts.map((p) => p.kind))
  assert.deepEqual(Object.keys(DARWIN_UNDO_BY_KIND), producible, 'a kind without its undo is red (the win32 twin\'s rule)')
  assert.deepEqual(producible.filter((k) => !KNOWN_KINDS.includes(k)), [], 'and the manifest reader knows each one')
})
