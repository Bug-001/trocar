// test/off/manifest.test.mjs — 1.6 R3: the install manifest carries a `version`, and every item carries a `kind` and one sentence of
// `undo_by_hand` (what to do without node) and its `phase` (D55); a version-1 or 2 manifest is refused (4.11 ⑰);
// a version this build does not know is flagged and never rewritten; an item of a kind this build does not know is listed so `off` can leave it alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MANIFEST_VERSION, KNOWN_KINDS, PHASES, newManifest, readManifest, saveManifest, readManifestAt, saveManifestAt, undoByHand, unknownItems, manifestPath, itemsOfPhase, parseManifest, installComplete, daemonMayStart } from '../../src/off/manifest.mjs'
import { applyJsonKey, applyTextEntry, writeOwnedFile } from '../../src/collector/core/trust/journal.mjs'
import { SENTINEL, OFF_PREFIX, lineComment } from '../../src/off/text-edit.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const T = new Date('2026-10-07T01:02:03.004Z')
const dirOf = () => { const home = tmpDir('trocar-man-'); return { home, dir: path.join(home, '.trocar', 'collector') } }
const writeRaw = (dir, obj) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(manifestPath(dir), JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 }) }

// 4.11 ⑰: a manifest written before the collector model (version 1 had no `version`, version 2 had `complete`) is not read: it comes back as the refusal's
// shape (test/off/v2-refusal.test.mjs has every command's refusal), and reading never writes.
test('R3: a version 1 or 2 manifest on disk reads as { unsupported: "v2" } and the file is not rewritten', () => {
  const { dir } = dirOf()
  for (const doc of [{ complete: true, entries: [], files: [] }, { version: 2, complete: true, entries: [{ kind: 'json-key', path: '/p', keys: ['k'], value: 'v' }], files: [] }]) {
    writeRaw(dir, doc)
    const before = fs.readFileSync(manifestPath(dir))
    const m = readManifest(dir)
    assert.deepEqual([m.unsupported, m.version, installComplete(m), daemonMayStart(m), m.entries], ['v2', doc.version ?? 1, false, false, undefined], 'a complete v2 install does not start the daemon either')
    // 1.6 §1.1: an install record (complete or partial) with a root on record; no root, no record → no
    const root = [{ kind: 'root-key', phase: 'install' }], ca = [{ kind: 'owned-file', role: 'ca-cert', phase: 'install' }]
    assert.deepEqual([[{ state: 'complete' }, root, []], [{ state: 'partial' }, [], ca], [{ state: 'partial' }, [], []], [null, root, ca]].map(([install, entries, files]) => daemonMayStart({ install, entries, files })), [true, true, false, false])
    assert.throws(() => saveManifest(dir, m), /will not write over it/)
    assert.deepEqual(fs.readFileSync(manifestPath(dir)), before)
  }
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
  assert.ok(block.includes(OFF_PREFIX.trimEnd()), 'and the prefix of a line trocar put out of effect')
  const line = undoByHand({ kind: 'text', path: '/h/.zshrc', format: 'line', line: 'export PATH="$HOME/shim:$PATH"' })
  assert.ok(line.includes('/h/.zshrc') && line.includes(JSON.stringify('export PATH="$HOME/shim:$PATH"')))
  assert.equal(undoByHand({ kind: 'owned-file', path: '/h/.trocar/collector/ca/x.pem' }), 'rm /h/.trocar/collector/ca/x.pem')
  assert.match(undoByHand({ kind: 'json-key', path: '/h/n.json', keys: ['k'], value: 'v', prior_value: null, existed_before: false }), /created|did not exist/, 'a file trocar created: delete it if nothing else is in it')
  // a kind this build does not know: what its writer recorded wins; with nothing recorded, never a made-up `rm`
  assert.equal(undoByHand({ kind: 'mystery', path: '/z', undo_by_hand: 'run the mystery tool' }), 'run the mystery tool')
  assert.ok(!/^rm /.test(undoByHand({ kind: 'mystery', path: '/z' })) && undoByHand({ kind: 'mystery', path: '/z' }).length > 10)
  for (const kind of KNOWN_KINDS.filter((k) => k.startsWith('legacy-'))) assert.ok(undoByHand({ kind, path: '/p' }).includes('/p'), kind)
})

// The old capture's ledger ~/.trocar/legacy-manifest.json is the same format in a file of its own (not in ~/.trocar/collector/, so the board does not think the new collector is installed).
test('the ledger of the old capture is a manifest in a file of its own: written 0600, its directory made 0700, read back, with kind and undo_by_hand filled in; a version it does not know is refused, never rewritten', () => {
  const dir = tmpDir('trocar-ledger-')
  const file = path.join(dir, '.trocar', 'legacy-manifest.json')
  assert.equal(readManifestAt(file), null, 'no ledger is null')
  const m = newManifest(new Date('2026-10-07T00:00:00Z'))
  m.entries.push({ kind: 'legacy-clash-block', harness: 'claude-code', path: '/v/Script.js', backup: '/b/1', installed_at: 'x', phase: 'on' })
  saveManifestAt(file, m)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  const back = readManifestAt(file)
  assert.deepEqual([back.version, back.entries.length, back.entries[0].kind], [MANIFEST_VERSION, 1, 'legacy-clash-block'])
  assert.match(back.entries[0].undo_by_hand, /old capture|trocar off/, 'a legacy kind has a sentence for a person with no node')
  assert.equal(fs.existsSync(manifestPath(path.dirname(file))), false, 'the install manifest is another file')
  fs.writeFileSync(file, JSON.stringify({ version: 99, entries: [] }))
  const odd = readManifestAt(file)
  assert.equal(odd.unsupported, true)
  assert.throws(() => saveManifestAt(file, odd), /version 99/)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 99, 'not written over')
  saveManifest(dir, newManifest()); assert.equal(readManifest(dir).version, MANIFEST_VERSION, 'saveManifest / readManifest are the same code with the install manifest\'s name')
})

// The audit's MEDIUM finding (semantics 2): JSON that parses but is not the manifest trocar wrote — `{"version":2}`, `entries: {…}`, `entries: [null]`, `files: null` — was accepted, and
// `off` then crashed before it did anything (or half-way, with the routing already off and no receipt). It is as unusable as a file that does not parse: the same error, and the
// same way on (R3: trocar's own marks).
test('R3: a manifest whose lists are not the lists of a manifest is an error, like one that does not parse — never "nothing installed"', () => {
  const { dir } = dirOf()
  const bad = {
    'no lists at all': { version: 3 },
    'version 3 without files': { version: 3, entries: [] },
    'version 3 without entries': { version: 3, files: [] },
    'entries is an object': { version: 3, entries: { a: 1 }, files: [] },
    'entries holds null': { version: 3, entries: [null], files: [] },
    'entries holds a string': { version: 3, entries: ['x'], files: [] },
    'files is null': { version: 3, entries: [], files: null },
    'files holds an array': { version: 3, entries: [], files: [[]] },
    'watched is a string': { version: 3, entries: [], files: [], watched: 'x' },
    'watched holds null': { version: 3, entries: [], files: [], watched: [null] },
    'dirs holds an object': { version: 3, entries: [], files: [], dirs: [{}] },
    'dirs is null': { version: 3, entries: [], files: [], dirs: null },
  }
  for (const [what, doc] of Object.entries(bad)) {
    writeRaw(dir, doc)
    assert.throws(() => readManifest(dir), /not an install manifest this build can use/, what)
    assert.throws(() => readManifestAt(manifestPath(dir)), /not an install manifest this build can use/, what)
  }
  assert.throws(() => { writeRaw(dir, { version: 3, entries: [null], files: [] }); readManifest(dir) }, /`entries\[0\]` is not an object/, 'it says which list and which item')
  assert.throws(() => { writeRaw(dir, { version: 3, entries: [] }); readManifest(dir) }, /`files` is missing/)
  assert.throws(() => { writeRaw(dir, { version: 3, entries: [], files: null }); readManifest(dir) }, /`files` is not a list \(null\)/)
  // what is allowed: empty lists; a manifest of a version this build does not know is handed back flagged, whatever shape
  writeRaw(dir, { version: 3, entries: [], files: [] })
  assert.deepEqual([readManifest(dir).entries, readManifest(dir).files, readManifest(dir).watched, readManifest(dir).dirs], [[], [], [], []], 'a list that may be absent is empty')
  writeRaw(dir, { version: 7, entries: 'whatever' })
  assert.equal(readManifest(dir).unsupported, true)
})

// ── D55: version 3, `phase` on every item.
test('D55 itemsOfPhase splits a v3 manifest by the command that wrote each item; a v4 one stays unsupported and is never saved over', () => {
  const { dir } = dirOf()
  const m = newManifest(T)
  m.entries.push({ kind: 'json-key', path: '/a', keys: ['k'], value: 'v', phase: 'on' }, { kind: 'system-root', path: 'darwin-user-trust:AB', store: 'darwin-user-trust', fp256: 'AB', phase: 'install' })
  m.files.push({ kind: 'owned-file', role: 'switch', path: '/s', phase: 'on' }, { kind: 'owned-file', role: 'bundle', path: '/b', phase: 'install' })
  saveManifest(dir, m)
  const back = readManifest(dir)
  assert.deepEqual([itemsOfPhase(back, 'on').map((x) => x.path), itemsOfPhase(back, 'install').map((x) => x.path)], [['/a', '/s'], ['darwin-user-trust:AB', '/b']])
  writeRaw(dir, { ...back, version: 4 })
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

test('D55 / 4.11 P13 the new kinds: known, each with a sentence of undo by hand; login-env is gone', () => {
  for (const k of ['system-root', 'json-array-item', 'root-key']) assert.ok(KNOWN_KINDS.includes(k), k)
  assert.ok(!KNOWN_KINDS.includes('login-env'), 'never emitted, and no undo: not a kind (4.11 P13)')
  assert.equal(undoByHand({ kind: 'system-root', store: 'win-currentuser-root', thumbprint: 'AB12' }), 'run: certutil -user -delstore Root AB12')
  assert.equal(undoByHand({ kind: 'system-root', store: 'darwin-user-trust', fp256: 'AA:BB', thumbprint: 'CC', cert_file: '/h/.trocar/collector/ca/trocar-ca.pem' }), 'run: security remove-trusted-cert /h/.trocar/collector/ca/trocar-ca.pem, then security delete-certificate -Z CC (the certificate with SHA-256 AA:BB)')
  assert.equal(undoByHand({ kind: 'json-array-item', path: '/s.json', keys: ['settingsSync.ignoredSettings'], item: 'http.proxy', created_array: true }), 'edit /s.json: remove "http.proxy" from the list settingsSync.ignoredSettings, then delete the list if it is now empty (trocar created it)')
  const key = (kind, id) => undoByHand({ kind: 'root-key', custody: { kind, id }, fp256: 'AA:BB' })
  assert.match(key('file', '/h/.trocar/collector/ca/root.key'), /^rm \/h\/\.trocar\/collector\/ca\/root\.key \(.*SHA-256 AA:BB/)
  assert.match(key('cng', 'trocar-root'), /certutil -user -csp "Microsoft Software Key Storage Provider" -delkey "trocar-root"/)
  assert.match(key('keychain', 'trocar-root'), /login keychain/)
  assert.match(undoByHand({ kind: 'text', format: 'pem-block', path: '/h/my.pem' }), /^edit \/h\/my\.pem: delete the lines from "# >>> trocar collector >>>.*" to "# <<< trocar collector <<<" at its end/)
  assert.equal(undoByHand({ kind: 'owned-file', role: 'wrapper', path: '/h/bin/kimi', real: '/h/bin/.trocar-real/kimi', sha256: 'ab' }), 'if sha256 of /h/bin/kimi is still ab: mv /h/bin/.trocar-real/kimi /h/bin/kimi; otherwise: rm /h/bin/.trocar-real/kimi (the program was updated over the wrapper)')
  for (const role of ['switch', 'config-entry']) assert.equal(undoByHand({ kind: 'owned-file', role, path: '/h/x y' }), "rm '/h/x y'")
})

// T11 (plan §E.5 #1): the undo knows the collector model's kinds (root-key, wrapper / switch / config-entry, pem-block, a real json-array-item undo) and refuses a
// v2 manifest and an unknown kind before it changes anything; a copy written by 12 lists those kinds as unknown and would undo a v2 manifest it no longer reads right.
