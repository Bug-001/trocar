// test/off/manifest.test.mjs — 1.6 R3: the install manifest carries a `version`, and every item carries a `kind` and one sentence of
// `undo_by_hand` (what to do without node); a version-1 or 2 manifest reads as version 3, each item given its `phase` (D55, classifyV2);
// a version this build does not know is flagged and never rewritten; an item of a kind this build does not know is listed so `off` can leave it alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MANIFEST_VERSION, OFF_VERSION, KNOWN_KINDS, PHASES, newManifest, readManifest, saveManifest, readManifestAt, saveManifestAt, undoByHand, unknownItems, manifestPath, classifyV2, itemsOfPhase, parseManifest, installComplete } from '../../src/off/manifest.mjs'
import { applyJsonKey, applyTextEntry, writeOwnedFile } from '../../src/collector/core/trust/journal.mjs'
import { SENTINEL, OFF_PREFIX, lineComment } from '../../src/off/text-edit.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const T = new Date('2026-10-07T01:02:03.004Z')
const dirOf = () => { const home = tmpDir('asight-man-'); return { home, dir: path.join(home, '.asight', 'collector') } }
const writeRaw = (dir, obj) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(manifestPath(dir), JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 }) }

// What installCollector wrote before D39: version 1, no kind on a JSON entry, no backup, no undo_by_hand, no confirmed_paths /
// kept_backups / liveness. Copied from the shapes applyJsonKey / applyTextEntry / writeOwnedFile / install.mjs produced.
const H = '/home/u'
const V1 = () => ({
  version: 1, created_at: '2026-10-06T08:00:00.000Z', complete: true, engine_port: 47011,
  planned: [`${H}/.claude/settings.json`, `${H}/.codex/.env`, `${H}/.zshrc`],
  dirs: [`${H}/.asight`, `${H}/.asight/collector`, `${H}/.asight/collector/ca`],
  files: [
    { path: `${H}/.asight/collector/ca/ca.key`, role: 'ca-key' },
    { path: `${H}/.asight/collector/ca/asight-ca.pem`, role: 'ca-cert' },
    { path: `${H}/.asight/collector/ca/combined-codex.pem`, role: 'bundle', harness: 'codex', sha256: 'c0'.repeat(32), mode: 384, created_dirs: [], installed_at: '2026-10-06T08:00:01.000Z', user_fps: [], roots_fp: 'ab'.repeat(32) },
  ],
  watched: [{ path: `${H}/.config/x`, why: 'a plugin dir', harness: 'codex', existed_before: false }],
  entries: [
    { harness: 'claude-code', path: `${H}/.claude/settings.json`, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: `${H}/.asight/collector/ca/asight-ca.pem`, existed_before: true, mode: 420, pre_sha256: 'aa'.repeat(32), post_sha256: 'bb'.repeat(32), ops: [{ offset: 10, removed: '', inserted: '"x"' }], prior_value: null, existing_depth: 1, created_dirs: [], installed_at: '2026-10-06T08:00:02.000Z' },
    { harness: 'claude-code', path: `${H}/.claude/other.json`, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: '/new.pem', existed_before: true, mode: 420, pre_sha256: 'a1'.repeat(32), post_sha256: 'b1'.repeat(32), ops: [], prior_value: '/corp.pem', existing_depth: 2, created_dirs: [], installed_at: '2026-10-06T08:00:02.500Z' },
    { kind: 'text', harness: 'codex', path: `${H}/.codex/.env`, format: 'dotenv-block', vars: { SSL_CERT_FILE: `${H}/.asight/collector/ca/combined-codex.pem` }, existed_before: true, mode: 384, pre_sha256: 'cc'.repeat(32), post_sha256: 'dd'.repeat(32), ops: [{ offset: 0, removed: '', inserted: 'BLOCK' }], prior_value: { SSL_CERT_FILE: '/corp.pem' }, created_dirs: [], installed_at: '2026-10-06T08:00:03.000Z' },
    { kind: 'text', harness: 'kimi-code', path: `${H}/.zshrc`, format: 'line', line: 'export PATH="$HOME/.asight/shim:$PATH"', existed_before: true, mode: 420, pre_sha256: 'ee'.repeat(32), post_sha256: 'ff'.repeat(32), ops: [], prior_value: null, created_dirs: [], installed_at: '2026-10-06T08:00:04.000Z' },
  ],
})

test('R3: a version 1 manifest on disk reads as version 3: every entry has kind, a non-empty undo_by_hand, scope and phase (an automatic item reads as agent), nothing else changes, the file is not rewritten', () => {
  const { dir } = dirOf(); const v1 = V1(); writeRaw(dir, v1)
  const before = fs.readFileSync(manifestPath(dir))
  const m = readManifest(dir)
  assert.equal(m.version, MANIFEST_VERSION); assert.equal(MANIFEST_VERSION, 3)
  assert.equal(m.upgraded_from, 1)
  assert.ok(!m.unsupported)
  assert.deepEqual(m.entries.map((e) => e.kind), ['json-key', 'json-key', 'text', 'text'], 'a JSON entry had no kind; a text entry already did')
  for (const e of m.entries) { assert.equal(e.backup, null, 'no backup existed before D39'); assert.ok(typeof e.undo_by_hand === 'string' && e.undo_by_hand.length > 10, e.path) }
  for (const f of m.files) { assert.equal(f.kind, 'owned-file', f.path); assert.match(f.undo_by_hand, new RegExp(f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) }
  assert.deepEqual([m.confirmed_paths, m.kept_backups, m.liveness], [[], [], {}], 'the v2 top-level fields exist, empty')
  // everything v1 held is still there, as it was
  assert.deepEqual([...m.entries, ...m.files].map((x) => x.phase), Array(7).fill('install'), 'v1 held only trust entries and certificate files: all install\'s')
  const strip = (o) => { const { kind, backup, undo_by_hand, scope, phase, ...rest } = o; return rest }
  assert.deepEqual(m.entries.map(strip), v1.entries.map(strip))
  assert.deepEqual(m.files.map(strip), v1.files.map(strip))
  assert.deepEqual([m.planned, m.dirs, m.watched, m.engine_port, m.created_at], [v1.planned, v1.dirs, v1.watched, v1.engine_port, v1.created_at])
  assert.deepEqual(['complete' in m, m.install, installComplete(m)], [false, null, false], 'v1\'s complete goes; install stays null until `install` runs (D55)')
  assert.deepEqual(fs.readFileSync(manifestPath(dir)), before, 'reading never writes: a build that only looks leaves the v1 file for the build that wrote it')
})

test('R3: the manifest written by the journal is version 3 and every item, entries and files, has kind, undo_by_hand (also the ones pushed without) and the phase its writer gave', () => {
  const { home, dir } = dirOf(); const m = newManifest(T)
  const json = path.join(home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(json)); fs.writeFileSync(json, '{"env":{}}\n')
  applyJsonKey({ phase: 'install', home, dir, manifest: m, harness: 'claude-code', file: json, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: '/ca.pem', now: T })
  applyTextEntry({ phase: 'install', home, dir, manifest: m, harness: 'codex', file: path.join(home, '.codex', '.env'), edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: '/b.pem' } }, now: T })
  applyTextEntry({ phase: 'install', home, dir, manifest: m, harness: 'kimi-code', file: path.join(home, '.zshrc'), edit: { format: 'line', line: `export PATH=x ${lineComment('kimi shim')}` }, now: T })
  writeOwnedFile({ phase: 'install', dir, manifest: m, harness: 'codex', role: 'bundle', file: path.join(dir, 'ca', 'combined-codex.pem'), data: 'PEM\n', now: T })
  m.files.push({ path: path.join(dir, 'ca', 'ca.key'), role: 'ca-key', phase: 'install' }) // what install.mjs pushes for the CA, with nothing else
  saveManifest(dir, m)
  const back = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')) // the file itself: readManifest would fill in what is missing
  assert.equal(back.version, 3)
  assert.deepEqual([...back.entries, ...back.files].map((x) => x.phase), Array(5).fill('install'))
  assert.ok(!('upgraded_from' in back), 'a read-time fact is not saved')
  assert.deepEqual(back.entries.map((e) => e.kind), ['json-key', 'text', 'text'])
  assert.equal(back.files.length, 2)
  for (const it of [...back.entries, ...back.files]) { assert.ok(KNOWN_KINDS.includes(it.kind), `${it.path}: ${it.kind}`); assert.ok(it.undo_by_hand.length > 10, it.path) }
  assert.deepEqual(unknownItems(readManifest(dir)), [])
  assert.equal(fs.statSync(manifestPath(dir)).mode & 0o777, 0o600)
})

test('R3: newManifest is version 3 with the new top-level fields empty (install and ca null, no complete), stamped with the time it is given', () => {
  assert.deepEqual(newManifest(T), { version: 3, created_at: '2026-10-07T01:02:03.004Z', install: null, ca: null, engine_port: null, planned: [], confirmed_paths: [], kept_backups: [], liveness: {}, dirs: [], files: [], entries: [] })
  assert.equal(newManifest().version, 3); assert.ok(Date.now() - Date.parse(newManifest().created_at) < 5000)
})

test('R3: a manifest of a version this build does not know is flagged unsupported, handed back as it is, and never saved over', () => {
  const { dir } = dirOf(); const v4 = { version: 4, install: { state: 'complete' }, items: [{ path: '/x', kind: 'something-new' }], entries: [{ path: '/y' }] }; writeRaw(dir, v4)
  const before = fs.readFileSync(manifestPath(dir))
  const m = readManifest(dir)
  assert.equal(m.unsupported, true)
  assert.equal(m.version, 4, 'the version it really has')
  assert.deepEqual(m.items, v4.items); assert.deepEqual(m.entries, v4.entries, 'not normalized: this build does not know what the fields mean')
  assert.throws(() => saveManifest(dir, m), /version 4/, 'saving it would write version 3 shapes over version 4 data')
  assert.deepEqual(fs.readFileSync(manifestPath(dir)), before)
})

test('R3: a missing manifest is null; one that does not parse throws (never "nothing installed")', () => {
  const { dir } = dirOf()
  assert.equal(readManifest(dir), null)
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(manifestPath(dir), '{"version": 2, "entries": [')
  assert.throws(() => readManifest(dir), SyntaxError)
})

test('R3: unknownItems lists an entry or a file whose kind this build does not know, with its path and kind', () => {
  const m = newManifest(T)
  m.entries.push({ kind: 'json-key', path: '/a', keys: ['k'], value: 'v', phase: 'install' }, { kind: 'mystery', path: '/b', phase: 'on' })
  m.files.push({ kind: 'owned-file', path: '/c', role: 'unit', phase: 'on' }, { kind: 'future-thing', path: '/d', role: 'x', phase: 'install' })
  assert.deepEqual(unknownItems(m), [{ path: '/b', kind: 'mystery' }, { path: '/d', kind: 'future-thing' }])
  assert.deepEqual(unknownItems(newManifest(T)), [])
  assert.ok(KNOWN_KINDS.includes('legacy-clash-block') && !KNOWN_KINDS.includes('mystery'))
  // it survives a save and a read: the unknown item is kept as it was, not dropped and not "fixed"
  const { dir } = dirOf(); saveManifest(dir, m)
  assert.deepEqual(unknownItems(readManifest(dir)), [{ path: '/b', kind: 'mystery' }, { path: '/d', kind: 'future-thing' }])
  assert.equal(readManifest(dir).entries[1].kind, 'mystery')
})

test('R3: undoByHand says, in one sentence, how to take each kind of item out without node', () => {
  const jsonNew = undoByHand({ kind: 'json-key', path: '/h/.claude/settings.json', keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: '/ca.pem', prior_value: null })
  assert.match(jsonNew, /\/h\/\.claude\/settings\.json/); assert.match(jsonNew, /env\.NODE_EXTRA_CA_CERTS/); assert.match(jsonNew, /delete/i)
  const jsonPrior = undoByHand({ kind: 'json-key', path: '/h/s.json', keys: ['env', 'K'], value: '/ca.pem', prior_value: '/corp.pem' })
  assert.match(jsonPrior, /\/corp\.pem/); assert.match(jsonPrior, /env\.K/)
  const block = undoByHand({ kind: 'text', path: '/h/.codex/.env', format: 'dotenv-block', vars: { SSL_CERT_FILE: '/b.pem' } })
  assert.ok(block.includes(`# >>> ${SENTINEL} >>>`) && block.includes(`# <<< ${SENTINEL} <<<`), 'the sentinels the file really holds')
  assert.ok(block.includes(OFF_PREFIX.trimEnd()), 'and the prefix of a line asight put out of effect')
  const line = undoByHand({ kind: 'text', path: '/h/.zshrc', format: 'line', line: 'export PATH="$HOME/shim:$PATH"' })
  assert.ok(line.includes('/h/.zshrc') && line.includes(JSON.stringify('export PATH="$HOME/shim:$PATH"')))
  assert.equal(undoByHand({ kind: 'owned-file', path: '/h/.asight/collector/ca/x.pem' }), 'rm /h/.asight/collector/ca/x.pem')
  assert.match(undoByHand({ kind: 'json-key', path: '/h/n.json', keys: ['k'], value: 'v', prior_value: null, existed_before: false }), /created|did not exist/, 'a file asight created: delete it if nothing else is in it')
  // a kind this build does not know: what its writer recorded wins; with nothing recorded, never a made-up `rm`
  assert.equal(undoByHand({ kind: 'mystery', path: '/z', undo_by_hand: 'run the mystery tool' }), 'run the mystery tool')
  assert.ok(!/^rm /.test(undoByHand({ kind: 'mystery', path: '/z' })) && undoByHand({ kind: 'mystery', path: '/z' }).length > 10)
  for (const kind of KNOWN_KINDS.filter((k) => k.startsWith('legacy-'))) assert.ok(undoByHand({ kind, path: '/p' }).includes('/p'), kind)
})

// The old capture's ledger ~/.asight/legacy-manifest.json is the same format in a file of its own (not in ~/.asight/collector/, so the board does not think the new collector is installed).
test('the ledger of the old capture is a manifest in a file of its own: written 0600, its directory made 0700, read back, with kind and undo_by_hand filled in; a version it does not know is refused, never rewritten', () => {
  const dir = tmpDir('asight-ledger-')
  const file = path.join(dir, '.asight', 'legacy-manifest.json')
  assert.equal(readManifestAt(file), null, 'no ledger is null')
  const m = newManifest(new Date('2026-10-07T00:00:00Z'))
  m.entries.push({ kind: 'legacy-clash-block', harness: 'claude-code', path: '/v/Script.js', backup: '/b/1', installed_at: 'x', phase: 'on' })
  saveManifestAt(file, m)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  const back = readManifestAt(file)
  assert.deepEqual([back.version, back.entries.length, back.entries[0].kind], [MANIFEST_VERSION, 1, 'legacy-clash-block'])
  assert.match(back.entries[0].undo_by_hand, /old capture|asight off/, 'a legacy kind has a sentence for a person with no node')
  assert.equal(fs.existsSync(manifestPath(path.dirname(file))), false, 'the install manifest is another file')
  fs.writeFileSync(file, JSON.stringify({ version: 99, entries: [] }))
  const odd = readManifestAt(file)
  assert.equal(odd.unsupported, true)
  assert.throws(() => saveManifestAt(file, odd), /version 99/)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 99, 'not written over')
  saveManifest(dir, newManifest()); assert.equal(readManifest(dir).version, MANIFEST_VERSION, 'saveManifest / readManifest are the same code with the install manifest\'s name')
})

// The audit's MEDIUM finding (semantics 2): JSON that parses but is not the manifest asight wrote — `{"version":2}`, `entries: {…}`, `entries: [null]`, `files: null` — was accepted, and
// `off` then crashed before it did anything (or half-way, with the routing already off and no receipt). It is as unusable as a file that does not parse: the same error, and the
// same way on (R3: asight's own marks).
test('R3: a manifest whose lists are not the lists of a manifest is an error, like one that does not parse — never "nothing installed"; a version 1 manifest may leave a list out', () => {
  const { dir } = dirOf()
  const bad = {
    'no lists at all': { version: 2 },
    'neither entries nor files, no version': {},
    'version 2 without files': { version: 2, entries: [] },
    'version 2 without entries': { version: 2, files: [] },
    'entries is an object': { version: 2, entries: { a: 1 }, files: [] },
    'entries holds null': { version: 2, entries: [null], files: [] },
    'entries holds a string': { version: 2, entries: ['x'], files: [] },
    'files is null': { version: 2, entries: [], files: null },
    'files holds an array': { version: 2, entries: [], files: [[]] },
    'watched is a string': { version: 2, entries: [], files: [], watched: 'x' },
    'watched holds null': { version: 2, entries: [], files: [], watched: [null] },
    'dirs holds an object': { version: 2, entries: [], files: [], dirs: [{}] },
    'dirs is null': { version: 2, entries: [], files: [], dirs: null },
    'version 1 with entries null': { version: 1, entries: null, files: [] },
  }
  for (const [what, doc] of Object.entries(bad)) {
    writeRaw(dir, doc)
    assert.throws(() => readManifest(dir), /not an install manifest this build can use/, what)
    assert.throws(() => readManifestAt(manifestPath(dir)), /not an install manifest this build can use/, what)
  }
  assert.throws(() => { writeRaw(dir, { version: 2, entries: [null], files: [] }); readManifest(dir) }, /`entries\[0\]` is not an object/, 'it says which list and which item')
  assert.throws(() => { writeRaw(dir, { version: 2, entries: [] }); readManifest(dir) }, /`files` is missing/)
  assert.throws(() => { writeRaw(dir, { version: 2, entries: [], files: null }); readManifest(dir) }, /`files` is not a list \(null\)/)
  // what is allowed: empty lists; a version 1 file with one list or the lists of its day; a manifest of a version this build does not know is handed back flagged, whatever shape
  writeRaw(dir, { version: 2, entries: [], files: [] })
  assert.deepEqual([readManifest(dir).entries, readManifest(dir).files, readManifest(dir).watched, readManifest(dir).dirs], [[], [], [], []], 'a list that may be absent is empty')
  writeRaw(dir, { version: 1, entries: [{ kind: 'json-key', harness: 'claude-code', path: '/p', keys: ['k'], value: 'v' }] })
  const v1 = readManifest(dir)
  assert.deepEqual([v1.upgraded_from, v1.files, v1.entries.length], [1, [], 1], 'a version 1 file without `files` reads as one with none')
  writeRaw(dir, { version: 7, entries: 'whatever' })
  assert.equal(readManifest(dir).unsupported, true)
})

// ── D55: version 3, `phase` on every item, classifyV2 (V42's classify half). The v2 manifests below were captured from the writers as they were
// before phase existed (a Linux turnOn of all seven harnesses, darwin / win32 proxy entries through createProxyEntries, the keychain / cert-user
// opt-ins), the sandbox paths folded to /HOME (test/fixtures/manifest-v2/).
const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'manifest-v2')
const captured = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'))
const readV2 = (doc) => { const { dir } = dirOf(); writeRaw(dir, doc); return { dir, m: readManifest(dir) } }
const phaseRows = (m) => [...m.entries.map((e) => [e.kind, e.harness ?? null, e.phase]), ...m.files.map((f) => [f.role, f.harness ?? null, f.phase])]

test('V42 the captured v2 manifests: every item gets the phase of the command that wrote it — proxy entries, autostart and logs on, certificates install; the cert opt-ins are one system-root', () => {
  const expect = {
    'linux-seven': [['json-key', 'claude-code', 'install'], ['text', 'codex', 'install'], ['text', 'deepseek-dsh', 'install'], ['text', 'hermes', 'install'], ['text', 'kimi-code', 'install'], ['json-key', 'z-code', 'install'],
      ['ca-key', null, 'install'], ['ca-cert', null, 'install'], ['trust-file', 'claude-code', 'install'], ['bundle', 'codex', 'install'], ['bundle', 'hermes', 'install'], ['trust-file', 'kimi-code', 'install'], ['bundle', 'z-code', 'install'],
      ['plugin', 'deepseek-dsh', 'install'], ['plugin', 'deepseek-dsh', 'install'], ['shim', 'kimi-code', 'install'], ['plugin', 'opencode', 'install'], ['unit', null, 'on'], ['daemon-log', null, 'on'], ['daemon-log', null, 'on']],
    'darwin-proxy': [['json-key', 'claude-code', 'install'], ['text', 'codex', 'install'], ['text', 'hermes', 'install'], ['json-key', 'claude-code', 'on'], ['text', 'codex', 'on'], ['text', 'hermes', 'on'],
      ['ca-key', null, 'install'], ['ca-cert', null, 'install'], ['bundle', 'codex', 'install'], ['bundle', 'hermes', 'install']],
    'darwin-optin': [['optin-rc-path', 'kimi-code', 'on'], ['system-root', null, 'install']],
    'win32-optin': [['optin-claude-policy', 'claude-code', 'on'], ['system-root', null, 'install']],
  }
  expect['win32-proxy'] = expect['darwin-proxy']
  for (const [name, rows] of Object.entries(expect)) {
    const doc = captured(name)
    assert.equal(doc.version, 2, `${name} is a v2 capture`)
    const { m } = readV2(doc)
    assert.deepEqual([m.version, m.upgraded_from, m.install, 'complete' in m], [3, 2, null, false], `${name}: v3 in memory, install null (on refuses until install runs)`)
    assert.deepEqual(phaseRows(m), rows, name)
    for (const it of [...m.entries, ...m.files]) assert.ok(PHASES.includes(it.phase) && it.undo_by_hand, `${name}: ${it.path}`)
  }
  const mac = readV2(captured('darwin-optin')).m.entries.find((e) => e.kind === 'system-root')
  const kc = captured('darwin-optin').entries.find((e) => e.kind === 'optin-keychain-cert')
  assert.deepEqual([mac.store, mac.fp256, mac.status, mac.installed_at, mac.harness], ['darwin-user-trust', kc.values.fp256, 'done', kc.installed_at, null])
  assert.match(mac.undo_by_hand, /security remove-trusted-cert .*then security delete-certificate -Z/)
  const win = readV2(captured('win32-optin')).m.entries.find((e) => e.kind === 'system-root')
  const cu = captured('win32-optin').entries.find((e) => e.kind === 'optin-cert-user')
  assert.deepEqual([win.store, win.thumbprint, win.status], ['win-currentuser-root', cu.values.thumbprint, 'done'])
  assert.equal(win.undo_by_hand, `run: certutil -user -delstore Root ${cu.values.thumbprint}`)
})

test('V42 classifyV2 is pure, and every certificate opt-in of a manifest (keychain, cert-user, cert-machine) collapses into ONE system-root with the earliest installed_at', () => {
  const doc = captured('win32-optin'); const cu = doc.entries.find((e) => e.kind === 'optin-cert-user')
  doc.entries.push({ ...cu, kind: 'optin-cert-machine', scope: 'machine', installed_at: '2026-10-01T00:00:00.000Z' }, { ...cu, installed_at: '2026-10-20T00:00:00.000Z' })
  const v2 = parseManifest(JSON.stringify(doc)) // the read classifies it; classifyV2 again over the v2 input itself:
  const input = { ...structuredClone(doc), entries: structuredClone(doc.entries) }
  const before = structuredClone(input); const out = classifyV2(input)
  assert.deepEqual(input, before, 'the input is not changed')
  for (const m of [v2, out]) {
    const roots = m.entries.filter((e) => e.kind === 'system-root')
    assert.equal(roots.length, 1, 'one certificate, one item')
    assert.deepEqual([roots[0].installed_at, roots[0].thumbprint, roots[0].phase], ['2026-10-01T00:00:00.000Z', cu.values.thumbprint, 'install'])
    assert.ok(!m.entries.some((e) => /^optin-cert|keychain/.test(e.kind)), 'the opt-in records are folded away')
  }
})

test('V42 classifyV2 of a file entry by its own values, over every loopback host × entry shape: a loopback proxy URL naming no ~/.asight path is on; a path of asight\'s, another host, or both is install', () => {
  const home = ['/home/u', 'C:\\Users\\u']
  const cases = []
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
    for (const url of [`http://${host}:18801`, `http://codex.env:${'f'.repeat(32)}@${host}:18801`]) {
      cases.push([{ kind: 'json-key', keys: ['env', 'HTTPS_PROXY'], value: url }, 'on'], [{ kind: 'text', format: 'dotenv-block', vars: { HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1,::1' } }, 'on'], [{ kind: 'trust-entry', format: 'dotenv-block', vars: { HTTPS_PROXY: url } }, 'on'], [{ kind: 'proxy-entry', value: url }, 'on'])
      for (const h of home) cases.push([{ kind: 'text', format: 'dotenv-block', vars: { HTTPS_PROXY: url, SSL_CERT_FILE: [h, '.asight', 'collector', 'ca', 'combined-codex.pem'].join(h.includes('\\') ? '\\' : '/') } }, 'install']) // an old block holding both halves: not a proxy-only record
    }
  }
  for (const h of home) {
    const ca = [h, '.asight', 'collector', 'ca', 'asight-ca.pem'].join(h.includes('\\') ? '\\' : '/')
    cases.push([{ kind: 'json-key', keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: ca }, 'install'], [{ kind: 'text', format: 'dotenv-block', vars: { SSL_CERT_FILE: ca } }, 'install'], [{ kind: 'trust-entry', value: ca }, 'install'])
  }
  cases.push([{ kind: 'json-key', keys: ['env', 'HTTPS_PROXY'], value: 'http://corp-proxy.example:3128' }, 'install'], [{ kind: 'text', format: 'line', line: 'export PATH="$HOME/.asight/collector/bin:$PATH"' }, 'install'], [{ kind: 'json-key', value: 'not a url' }, 'install'])
  for (const kind of KNOWN_KINDS.filter((k) => k.startsWith('optin-') && !/cert/.test(k))) cases.push([{ kind, harness: 'x', scope: 'user' }, 'on'])
  for (const kind of ['run-key', 'scheduled-task', 'legacy-env']) cases.push([{ kind }, 'on'])
  const m = classifyV2({ version: 2, entries: cases.map(([e], i) => ({ harness: 'h', path: `/f${i}`, ...e })), files: [] })
  assert.deepEqual(m.entries.map((e) => e.phase), cases.map(([, p]) => p), JSON.stringify(m.entries.map((e, i) => [e.phase, cases[i][1], e.value ?? e.vars ?? e.kind])))
  const files = classifyV2({ version: 2, entries: [], files: ['unit', 'daemon-log', 'forwarder-binary', 'ca-key', 'ca-cert', 'bundle', 'trust-file', 'plugin', 'shim', undefined].map((role, i) => ({ path: `/o${i}`, role })) }).files
  assert.deepEqual(files.map((f) => f.phase), ['on', 'on', 'on', 'install', 'install', 'install', 'install', 'install', 'install', 'install'])
})

test('V42 an upgraded manifest saves as version 3 with every phase, and reads back as itself; itemsOfPhase splits it; a v4 one stays unsupported and is never saved over', () => {
  const { dir, m } = readV2(captured('darwin-proxy'))
  saveManifest(dir, m)
  const disk = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')); assert.deepEqual([disk.version, 'upgraded_from' in disk, 'complete' in disk, disk.install], [3, false, false, null])
  const again = readManifest(dir); assert.deepEqual(phaseRows(again), phaseRows(m), 'read back as written: a v3 manifest is not classified again')
  assert.deepEqual(itemsOfPhase(again, 'on').map((x) => x.kind), ['json-key', 'text', 'text'])
  assert.equal(itemsOfPhase(again, 'install').length, 7)
  writeRaw(dir, { ...disk, version: 4 })
  const before = fs.readFileSync(manifestPath(dir))
  const v4 = readManifest(dir); assert.equal(v4.unsupported, true)
  assert.throws(() => saveManifest(dir, v4), /version 4/)
  assert.deepEqual(fs.readFileSync(manifestPath(dir)), before)
})

test('D55 save refuses a v3 item whose phase is missing or not install | on — an entry or a file — and leaves the file on disk as it was', () => {
  const { dir } = dirOf(); saveManifest(dir, newManifest(T))
  const before = fs.readFileSync(manifestPath(dir))
  for (const [where, item] of [['entries', { kind: 'json-key', path: '/a', keys: ['k'], value: 'v' }], ['files', { path: '/b', role: 'bundle' }], ['entries', { kind: 'text', path: '/c', line: 'x', format: 'line', phase: 'off' }]]) {
    const m = newManifest(T); m[where].push(item)
    assert.throws(() => saveManifest(dir, m), /has no phase \(install \| on\)/, JSON.stringify(item))
    assert.deepEqual(fs.readFileSync(manifestPath(dir)), before)
  }
})

test('D55 the new kinds: known, each with a sentence of undo by hand; OFF_VERSION is 11', () => {
  assert.equal(OFF_VERSION, 11); for (const k of ['system-root', 'login-env', 'json-array-item']) assert.ok(KNOWN_KINDS.includes(k), k)
  assert.equal(undoByHand({ kind: 'system-root', store: 'win-currentuser-root', thumbprint: 'AB12' }), 'run: certutil -user -delstore Root AB12')
  assert.equal(undoByHand({ kind: 'system-root', store: 'darwin-user-trust', fp256: 'AA:BB', thumbprint: 'CC', cert_file: '/h/.asight/collector/ca/asight-ca.pem' }), 'run: security remove-trusted-cert /h/.asight/collector/ca/asight-ca.pem, then security delete-certificate -Z CC (the certificate with SHA-256 AA:BB)')
  const env = undoByHand({ kind: 'login-env', name: 'NODE_EXTRA_CA_CERTS', value: '/x.pem', prior_value: '/corp.pem', carriers: [{ kind: 'text', path: '/h/.zshenv' }, { kind: 'reg-value', hive: 'HKCU', key: 'Environment', name: 'NODE_EXTRA_CA_CERTS' }] })
  assert.ok(env.includes('NODE_EXTRA_CA_CERTS') && env.includes('/h/.zshenv') && env.includes('HKCU\\Environment\\NODE_EXTRA_CA_CERTS') && env.includes('"/corp.pem"'), env)
  assert.equal(undoByHand({ kind: 'json-array-item', path: '/s.json', keys: ['settingsSync.ignoredSettings'], item: 'http.proxy', created_array: true }), 'edit /s.json: remove "http.proxy" from the list settingsSync.ignoredSettings, then delete the list if it is now empty (asight created it)')
})
