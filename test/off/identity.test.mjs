// test/off/identity.test.mjs — the name half of D51 (RFC 4.6 §身份与信任 R1 / R6): the
// normalizer, the derived facts names / name0 / rest, the user's ~/.trocar/agents.json (every problem code with its item and an actionable
// detail, G5), the merge with the presets, the compiler's refusals, and a compiled list surviving the manifest's JSON round trip (G8).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { SEEDS } from '../helpers/proc-seeds.mjs'
import { variantsOf } from '../helpers/proc-variants.mjs'
import { WIDE, normalizeName, processNames, name0, argRest, entryOf, compileIdentity, readAgentList, mergeAgentList } from '../../src/off/identity.mjs'
import { HARNESS_IDS } from '../../src/off/harness-names.mjs'
import { identityView, matchPattern, serializeSignature, reviveSignature } from '../../src/off/signature.mjs'
import { matchHarness } from '../helpers/one-harness.mjs'

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

test('entryOf: the program an interpreter runs — one exact candidate where argv is exact (spaces kept), every rejoin up to the next flag where it is a ps split', () => {
  assert.deepEqual(entryOf({ argv: ['node.exe', '--no-warnings', 'C:\\Users\\John Smith\\npm\\dsh\\lib\\bin.js', 'tui'] }), ['C:/Users/John Smith/npm/dsh/lib/bin.js'])
  assert.deepEqual(entryOf({ argv: ['node', '/home/u/my', 'tools/bin/kimi', '-p'], argvSplit: true }), ['/home/u/my', '/home/u/my tools/bin/kimi'])
  assert.deepEqual(entryOf({ argv: ['node', '--x', '/a/process.js', '--parent', '/usr/local/bin/dsh'], argvSplit: true }), ['/a/process.js'], 'a flag ends the rejoin: a later argument is never the entry')
  assert.deepEqual(entryOf({ argv: ['node', '--inspect'] }), [])
  assert.equal(entryOf({}), null)
})

test('entryOf (ps split): a word that starts a new path ends the rejoin, as a flag does — a wrapper naming the agent later is not the agent (review R1)', () => {
  assert.deepEqual(entryOf({ argv: ['node', '/tmp/wrapper.js', '/usr/local/bin/kimi'], argvSplit: true }), ['/tmp/wrapper.js'])
  assert.deepEqual(entryOf({ argv: ['node', '/tmp/ptc-runner.js', '~/bin/dsh'], argvSplit: true }), ['/tmp/ptc-runner.js'], 'a home path too')
  assert.deepEqual(entryOf({ argv: ['node', '/tmp/w.js', 'C:/x/dsh'], argvSplit: true }), ['/tmp/w.js'], 'a drive path too')
  assert.deepEqual(entryOf({ argv: ['node', '/Users/John', 'Smith/x.js', '/usr/local/bin/kimi'], argvSplit: true }), ['/Users/John', '/Users/John Smith/x.js'], 'a path with a space still rejoins: its second word starts no path')
  assert.deepEqual(entryOf({ argv: ['node', '/tmp/wrapper.js', '/usr/local/bin/kimi'] }), ['/tmp/wrapper.js'], 'exact argv: the same single candidate')
})

test('every variant of every seed keeps the seed\'s names, and rest (or, where the axis moves the script, its entry\'s program file) — the derived facts do not move with the install', () => {
  let n = 0
  for (const seed of SEEDS) {
    assert.ok(seed.source && (seed.harness === null || HARNESS_IDS.includes(seed.harness)), `seed shape: ${seed.exe}`)
    const file = (f) => { const e = entryOf(f); return e && e.length ? e.at(-1).split('/').pop() : null } // the program file the entry ends in
    const want = { names: new Set(processNames(seed)), rest: argRest(seed), file: file(seed) }
    const vs = variantsOf(seed)
    assert.ok(vs.length >= 8, `${seed.exe}: the generator bends it along the axes`)
    for (const v of vs) {
      n++
      assert.equal(v.harness, seed.harness)
      assert.deepEqual(new Set(processNames(v)), want.names, `${v.variant}: ${v.exe} ${JSON.stringify(v.argv)}`)
      if (/^(entry-space-cjk|flags:|home-space)/.test(v.variant) || /\+ps-split$/.test(v.variant)) {
        if (want.file != null) assert.ok(entryOf(v).some((e) => e.endsWith(`/${want.file}`) || e === want.file), `${v.variant}: the entry still runs ${want.file}: ${JSON.stringify(v.argv)}`)
      } else assert.equal(argRest(v), want.rest, `${v.variant}: ${JSON.stringify(v.argv)}`)
    }
  }
  assert.ok(n > 500, `${n} variants`)
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

test('G8: a compiled list answers the same after the manifest round trip (serialize → JSON → revive), for every seed and variant', () => {
  const sigs = [compileIdentity(DSH_LIKE), compileIdentity(CC_LIKE)]
  const back = sigs.map((s) => reviveSignature(JSON.stringify(serializeSignature(s))))
  const answer = (s, f) => { const v = identityView(f); return [s.match.some((p) => matchPattern(p, v)), s.exclude.some((p) => matchPattern(p, v)), s.longLived.some((p) => matchPattern(p, v))] }
  let hits = 0
  for (const seed of SEEDS) {
    for (const f of [seed, ...variantsOf(seed)]) {
      sigs.forEach((s, i) => {
        const a = answer(s, f)
        if (a[0]) hits++
        assert.deepEqual(answer(back[i], f), a, `${f.variant || 'seed'}: ${f.exe}`)
      })
    }
  }
  assert.ok(hits > 50, `the sample signatures match some facts (${hits}); a round trip of patterns that never match proves nothing`)
})

const writeList = (home, doc) => {
  fs.mkdirSync(path.join(home, '.trocar'), { recursive: true })
  fs.writeFileSync(path.join(home, '.trocar', 'agents.json'), typeof doc === 'string' ? doc : JSON.stringify(doc))
}

test('readAgentList: absent, ok, and one item per problem code (code, index, an actionable detail)', () => {
  const home = tmpDir('trocar-agents-')
  const absent = readAgentList({ home })
  assert.deepEqual([absent.state, absent.entries, absent.problems, absent.path], ['absent', [], [], path.join(home, '.trocar', 'agents.json')])
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
  for (const id of HARNESS_IDS) assert.match(detail[3], new RegExp(id), 'unknown-harness lists every id')
  assert.match(detail[5], /"codex"/, 'the separator detail names the program name to write')
  assert.match(detail[6], /python.*"args"/, 'the wide-name detail says to add args')
  assert.match(detail[8], /201.*200/)
  for (const p of r.problems) assert.match(p.detail, new RegExp(`^agents\\[${p.index}\\]: `))
})

test('readAgentList: whole-file problems have index null; not-there and unreadable are apart', () => {
  const home = tmpDir('trocar-agents-')
  writeList(home, '{ nope')
  assert.deepEqual([readAgentList({ home }).state, readAgentList({ home }).problems.map((p) => [p.index, p.code])], ['unparsable', [[null, 'unparsable']]])
  writeList(home, { version: 2, agents: [] })
  const v = readAgentList({ home })
  assert.deepEqual([v.state, v.problems[0].index, v.problems[0].code], ['unparsable', null, 'bad-version'])
  assert.match(v.problems[0].detail, /"version": 1/)
  writeList(home, { version: 1, agents: {} })
  assert.equal(readAgentList({ home }).problems[0].code, 'unparsable')
  writeList(home, { version: 1, agents: [] })
  fs.chmodSync(path.join(home, '.trocar', 'agents.json'), 0o000)
  try {
    const u = readAgentList({ home })
    if (process.getuid && process.getuid() === 0) return // root reads a 000 file
    assert.deepEqual([u.state, u.problems[0].index, u.problems[0].code], ['unreadable', null, 'EACCES'])
    assert.match(u.problems[0].detail, /permissions/)
  } finally { fs.chmodSync(path.join(home, '.trocar', 'agents.json'), 0o600) }
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
