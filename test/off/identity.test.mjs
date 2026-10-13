// test/off/identity.test.mjs — the name half of D51 (RFC 4.6 §身份与信任 R1 / R6; plan 2026-10-14-d51-name-allowlist §2.1–2.2): the
// normalizer, the derived facts names / name0 / rest, the user's ~/.asight/agents.json (every problem code with its item and an actionable
// detail, G5), the merge with the presets, the compiler's refusals, and a compiled list surviving the manifest's JSON round trip (G8).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { WIDE, HARNESS_IDS, normalizeName, processNames, name0, argRest, compileIdentity, readAgentList, mergeAgentList } from '../../src/off/identity.mjs'
import { identityView, matchHarness, matchPattern, serializeSignature, reviveSignature } from '../../src/off/signature.mjs'

test('normalizeName: quotes, (deleted), both separators, case, .exe, version-named files', () => {
  const table = [
    ['/home/u/.local/bin/claude (deleted)', 'claude'],
    [String.raw`C:\Users\u\.local\bin\Claude.EXE`, 'claude'],
    [String.raw`"C:\Program Files\nodejs\node.exe"`, 'node'],
    ['C:/Users/u/bin/codex.exe', 'codex'],
    ['/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper', 'claude helper'],
    ['/home/u/.local/share/claude/versions/2.1.296', 'claude'],
    ['/home/u/.local/share/claude/versions/2.1.296 (deleted)', 'claude'],
    ['/opt/kimi/bin/1.4.0', 'kimi'],
    ['/opt/kimi/v1.4.0-beta.2', 'kimi'],
    ['/opt/claude/bin/claude-nightly', 'claude-nightly'],
    ['/opt/claude/tools/rg', 'rg'],
    ['.opencode', '.opencode'],
    ['kimi-code', 'kimi-code'],
    ['', null],
    ['/', null],
    ['/versions/2.1.0', null],
    [null, null],
  ]
  for (const [p, want] of table) assert.equal(normalizeName(p), want, JSON.stringify(p))
})

test('normalizeName folds the interpreter families of WIDE only', () => {
  for (let n = 0; n <= 20; n++) {
    for (const s of [`python3.${n}`, `python3.${n}t`, `/x/bin/python3.${n}`, String.raw`C:\h\venv\Scripts\python3.${n}.exe`]) assert.equal(normalizeName(s), 'python', s)
  }
  for (const s of ['python3', 'python', 'python.exe', 'Python3.EXE']) assert.equal(normalizeName(s), 'python', s)
  for (const s of ['node22', 'nodejs', 'node.exe', '/usr/bin/nodejs']) assert.equal(normalizeName(s), 'node', s)
  assert.equal(normalizeName('ruby3.3'), 'ruby')
  assert.equal(normalizeName('x264'), 'x264', 'x is no interpreter')
  assert.equal(normalizeName('node22t'), 'node22t', 'the free-threaded t is Python only')
  assert.equal(normalizeName('claude2'), 'claude2')
  for (const w of WIDE) assert.ok(w === 'nodejs' || normalizeName(w) === w, `${w} is its own normalized name`)
})

test('processNames / name0 / argRest', () => {
  assert.deepEqual(processNames({ exe: '/home/u/.local/share/claude/versions/2.1.296', argv: ['claude', '-p'] }), ['claude'])
  assert.deepEqual(processNames({ exe: '/a/ZCode Helper', argv: ['zcode-cli'] }), ['zcode helper', 'zcode-cli'])
  assert.deepEqual(processNames({ exe: null, argv: [] }), [])
  assert.deepEqual(processNames({}), [])
  assert.equal(name0({ exe: '/x/claude', argv: ['/usr/bin/rg', '--files'] }), 'rg')
  assert.equal(name0({ exe: '/x/claude' }), null)
  assert.equal(argRest({ argv: ['node.exe', '"C:\\Users\\u\\npm\\dsh\\lib\\bin.js"', 'tui'] }), 'C:/Users/u/npm/dsh/lib/bin.js tui')
  assert.equal(argRest({ argv: ['node', 'C:/Users/u/npm/dsh/lib/bin.js', 'tui'] }), 'C:/Users/u/npm/dsh/lib/bin.js tui', '.ps1 forward slashes give the same string (W76)')
  assert.equal(argRest({ argv: ['claude'] }), '')
  assert.equal(argRest({ argv: undefined }), null)
})

test('identityView: lazy names / name0 / rest, env not read unless a pattern asks', () => {
  let envReads = 0
  const facts = { exe: '/x/claude', argv: ['claude', '-p', 'hi'], env: () => { envReads++; return new Map([['A', '1']]) } }
  const v = identityView(facts)
  assert.deepEqual([v.names, v.name0, v.rest, v.exe], [['claude'], 'claude', '-p hi', '/x/claude'])
  assert.equal(envReads, 0)
  assert.equal(matchPattern({ names: /^claude$/, env: { A: '1' } }, v), true)
  assert.equal(envReads, 1)
})

const DSH_LIKE = { harness: 'deepseek-dsh', names: [{ name: 'node', args: String.raw`^(\S+ ){0,2}\S*(/dsh|@deepseek-ai/dsh/lib/bin\.js)( |$)` }, { name: 'deepseek harness' }], exclude: [{ name: 'node', args: 'subprocess-runner' }], longLived: [{ args: '^serve' }] }
const CC_LIKE = { harness: 'claude-code', names: [{ name: 'claude' }], exclude: [{ name0: ['rg', 'apply-seccomp'] }, { name: 'claude', env: { NO_AGENT: '1' } }] }

test('compileIdentity: the signature shape; refuses /g /y, a wide name without args, a foreign exclude name', () => {
  const sig = compileIdentity(DSH_LIKE)
  assert.deepEqual(Object.keys(sig), ['match', 'exclude', 'longLived'])
  const live = { 'deepseek-dsh': { signature: serializeSignature(sig) }, 'claude-code': { signature: serializeSignature(compileIdentity(CC_LIKE)) } }
  assert.equal(matchHarness(live, { exe: '/usr/bin/node', argv: ['node', '--use-openssl-ca', '/usr/local/bin/dsh', 'tui'] }), 'deepseek-dsh')
  assert.equal(matchHarness(live, { exe: '/usr/bin/node', argv: ['node', '/srv/mcp.js'] }), null, 'node without the entry: no item')
  assert.equal(matchHarness(live, { exe: '/usr/bin/node', argv: ['node', '/usr/local/bin/dsh', 'subprocess-runner'] }), null, 'excluded')
  assert.equal(matchHarness(live, { exe: '/x/claude/versions/2.1.0', argv: ['rg', '--files'] }), null, 'excluded by name0')
  assert.equal(matchHarness(live, { exe: '/x/claude/versions/2.1.0', argv: ['claude'], env: new Map([['NO_AGENT', '1']]) }), null, 'excluded by env')
  assert.equal(matchHarness(live, { exe: '/x/claude/versions/2.1.0', argv: ['claude'], env: null }), 'claude-code', 'env null: the env item does not hold')
  assert.throws(() => compileIdentity({ harness: 'hermes', names: [{ name: 'python' }] }), /hermes.*python.*args/)
  assert.throws(() => compileIdentity({ harness: 'codex', names: [{ name: 'codex', args: /x/g }] }), /codex.*\/g and \/y/)
  assert.throws(() => compileIdentity({ harness: 'codex', names: [{ name: 'codex', args: /x/y }] }), /\/g and \/y/)
  assert.throws(() => compileIdentity({ harness: 'codex', names: [{ name: 'codex' }], exclude: [{ name: 'node' }] }), /codex.*"node" is not one of the names/)
  assert.throws(() => compileIdentity({ harness: 'codex', names: [{ name: 'codex' }], exclude: [{}] }), /needs name, name0, args or env/)
  assert.throws(() => compileIdentity({ harness: 'codex', names: [{ name: '/usr/bin/codex' }] }), /not a normalized program name/)
  assert.throws(() => compileIdentity({ harness: 'codex', names: [{ name: 'codex', args: '(' }] }), /not a regular expression/)
})

const writeList = (home, doc) => {
  fs.mkdirSync(path.join(home, '.asight'), { recursive: true })
  fs.writeFileSync(path.join(home, '.asight', 'agents.json'), typeof doc === 'string' ? doc : JSON.stringify(doc))
}

test('readAgentList: absent, ok, and one item per problem code (code, index, an actionable detail)', () => {
  const home = tmpDir('asight-agents-')
  const absent = readAgentList({ home })
  assert.deepEqual([absent.state, absent.entries, absent.problems, absent.path], ['absent', [], [], path.join(home, '.asight', 'agents.json')])
  writeList(home, { version: 1, agents: [
    { harness: 'claude-code', name: 'claude-nightly' }, //                 0 ok
    { harness: 'deepseek-dsh', name: 'node', args: String.raw`my-fork/bin\.js` }, // 1 ok
    { harness: 'codex', name: 'codex', ignore: true }, //                  2 ok
    { harness: 'claude', name: 'claude' }, //                              3 unknown-harness
    { harness: 'codex', name: '  ' }, //                                   4 name-empty
    { harness: 'codex', name: '/opt/codex/bin/codex' }, //                 5 name-has-separator
    { harness: 'hermes', name: 'python3.14' }, //                          6 wide-name-needs-args
    { harness: 'hermes', name: 'python', args: '(' }, //                   7 args-not-regex
    { harness: 'hermes', name: 'python', args: 'x'.repeat(201) }, //       8 args-too-long
    { harness: 'claude-code', name: 'Claude-Nightly.exe' }, //             9 duplicate (of 0, once normalized)
    'claude', //                                                           10 unknown-harness
  ] })
  const r = readAgentList({ home })
  assert.equal(r.state, 'ok')
  assert.deepEqual(r.entries, [
    { index: 0, harness: 'claude-code', name: 'claude-nightly' },
    { index: 1, harness: 'deepseek-dsh', name: 'node', args: String.raw`my-fork/bin\.js` },
    { index: 2, harness: 'codex', name: 'codex', ignore: true },
  ])
  assert.deepEqual(r.problems.map((p) => [p.index, p.code]), [
    [3, 'unknown-harness'], [4, 'name-empty'], [5, 'name-has-separator'], [6, 'wide-name-needs-args'],
    [7, 'args-not-regex'], [8, 'args-too-long'], [9, 'duplicate'], [10, 'unknown-harness'],
  ])
  const detail = Object.fromEntries(r.problems.map((p) => [p.index, p.detail]))
  for (const id of HARNESS_IDS) assert.match(detail[3], new RegExp(id), 'unknown-harness lists the seven ids')
  assert.match(detail[5], /"codex"/, 'the separator detail names the program name to write')
  assert.match(detail[6], /python.*"args"/, 'the wide-name detail says to add args')
  assert.match(detail[8], /201.*200/)
  for (const p of r.problems) assert.match(p.detail, new RegExp(`^agents\\[${p.index}\\]: `))
})

test('readAgentList: whole-file problems have index null; not-there and unreadable are apart', () => {
  const home = tmpDir('asight-agents-')
  writeList(home, '{ nope')
  assert.deepEqual([readAgentList({ home }).state, readAgentList({ home }).problems.map((p) => [p.index, p.code])], ['unparsable', [[null, 'unparsable']]])
  writeList(home, { version: 2, agents: [] })
  const v = readAgentList({ home })
  assert.deepEqual([v.state, v.problems[0].index, v.problems[0].code], ['unparsable', null, 'bad-version'])
  assert.match(v.problems[0].detail, /"version": 1/)
  writeList(home, { version: 1, agents: {} })
  assert.equal(readAgentList({ home }).problems[0].code, 'unparsable')
  writeList(home, { version: 1, agents: [] })
  fs.chmodSync(path.join(home, '.asight', 'agents.json'), 0o000)
  try {
    const u = readAgentList({ home })
    if (process.getuid && process.getuid() === 0) return // root reads a 000 file
    assert.deepEqual([u.state, u.problems[0].index, u.problems[0].code], ['unreadable', null, 'EACCES'])
    assert.match(u.problems[0].detail, /permissions/)
  } finally { fs.chmodSync(path.join(home, '.asight', 'agents.json'), 0o600) }
  const inj = readAgentList({ home, fs: { readFileSync: () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }) } } })
  assert.deepEqual([inj.state, inj.problems[0].code], ['unreadable', 'EIO'])
})

test('mergeAgentList: custom after the preset; ignore without args drops every same-name item, with args only the same-source one', () => {
  const presets = {
    'deepseek-dsh': { names: [{ name: 'node', args: /^dsh/ }, { name: 'node', args: 'bin\\.js' }, { name: 'deepseek harness' }], exclude: [{ name: 'node', args: 'runner' }] },
    codex: { names: [{ name: 'codex' }] },
  }
  const m = mergeAgentList(presets, [
    { harness: 'deepseek-dsh', name: 'node', args: 'my-fork' },
    { harness: 'deepseek-dsh', name: 'node', args: 'bin\\.js', ignore: true },
    { harness: 'codex', name: 'codex', ignore: true },
    { harness: 'z-code', name: 'zcode-nightly' },
  ])
  assert.deepEqual(m['deepseek-dsh'].names, [{ name: 'node', args: /^dsh/, source: 'preset' }, { name: 'deepseek harness', source: 'preset' }, { name: 'node', args: 'my-fork', source: 'custom' }])
  assert.deepEqual(m['deepseek-dsh'].ignored, [{ name: 'node', args: 'bin\\.js', source: 'preset' }])
  assert.deepEqual(m['deepseek-dsh'].exclude, presets['deepseek-dsh'].exclude, 'the preset\'s exclude passes through')
  assert.deepEqual([m.codex.names, m.codex.ignored], [[], [{ name: 'codex', source: 'preset' }]])
  assert.deepEqual(m['z-code'].names, [{ name: 'zcode-nightly', source: 'custom' }])
  assert.equal(compileIdentity({ harness: 'deepseek-dsh', ...m['deepseek-dsh'] }).match.length, 3, 'the merged list compiles')
  const once = mergeAgentList(presets, [{ harness: 'deepseek-dsh', name: 'node', args: '^dsh', ignore: true }])
  assert.equal(once['deepseek-dsh'].ignored.length, 1, 'a RegExp preset compares by its source text')
})
