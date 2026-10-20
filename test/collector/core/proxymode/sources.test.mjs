// test/collector/core/proxymode/sources.test.mjs — the one reader of descriptor data (spec 4.11 §2.3, plan A.3): generated over format × key path
// (with '*') × env override set / unset × base home / cwd × perOs darwin / win32, and every file state: present, absent (unset), unreadable and
// unparsable (an error, never unset: D38).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { resolveLoc, readSrc, holds, isPresent } from '../../../../src/collector/core/proxymode/sources.mjs'

const yamlOf = (v, ind = '') => Object.entries(v).map(([k, x]) => Array.isArray(x)
  ? `${ind}${k}:\n${x.map((m) => Object.entries(m).map(([a, b], i) => `${ind}  ${i ? ' ' : '-'} ${a}: "${b}"`).join('\n')).join('\n')}`
  : x && typeof x === 'object' ? `${ind}${k}:  # a comment\n${yamlOf(x, ind + '  ')}` : `${ind}${k}: '${x}'`).join('\n')
const WRITE = {
  json: (v) => JSON.stringify(v, null, 2),
  jsonc: (v) => `// trocar test\n${JSON.stringify(v, null, 2).replace(/\n}$/, ',\n}')}`,
  yaml: (v) => `---\n${yamlOf(v)}\n`,
  dotenv: (v) => Object.entries(v).map(([k, x]) => `${k}="${x}"`).join('\n'),
}
const BROKEN = { json: '{"a":', jsonc: '{ a: ', yaml: 'a: [1, 2\n' } // dotenv has no unparsable text: a line it cannot read is skipped, as the agents do
// key path → [document, the value it must find, the key path found]
const SHAPES = {
  flat: { keys: ['HTTPS_PROXY'], doc: { HTTPS_PROXY: 'http://u.example:1', OTHER: 'x' }, found: 'HTTPS_PROXY' },
  nested: { keys: ['network', 'httpProxy'], doc: { network: { httpProxy: 'http://n.example:2' } }, found: 'network.httpProxy' },
  starMap: { keys: ['env', '*'], doc: { env: { A: 'one', B: 'two' } }, found: 'env.A' },
  starList: { keys: ['routes', '*', 'ssl_ca_cert'], doc: { routes: [{ name: 'r0' }, { name: 'r1', ssl_ca_cert: '/u/ca.pem' }] }, found: 'routes.1.ssl_ca_cert' },
}
const valueOf = (s) => s.keys.reduce((v, k) => (k === '*' ? Object.values(v).find((x) => x && (typeof x !== 'object' || 'ssl_ca_cert' in x)) : v[k]), s.doc)
const fits = (format, s) => format !== 'dotenv' || s.keys.length === 1
const ctxOf = (root, os, env = {}, over = {}) => ({
  os, home: path.join(root, 'home'), cwd: path.join(root, 'proj'), env, dirs: { appSupport: path.join(root, 'as'), localAppData: path.join(root, 'la') },
  readFile: (p) => fs.readFileSync(p, 'utf8'), exists: (p) => fs.existsSync(p), readdir: (p) => fs.readdirSync(p), which: () => null, ...over,
})
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }

for (const format of Object.keys(WRITE)) for (const [shape, s] of Object.entries(SHAPES)) if (fits(format, s)) for (const base of ['home', 'cwd']) for (const os of ['darwin', 'win32']) for (const overridden of [false, true]) {
  test(`readSrc · ${format} · ${shape} · base ${base} · ${os} · env override ${overridden ? 'set' : 'unset'}`, () => {
    const root = tmpDir('trocar-src-')
    const loc = { perOs: { darwin: { base, dir: '.mac-agent', path: 'conf', env: 'AGENT_HOME' }, win32: { base, dir: 'win-agent', path: 'conf', env: 'AGENT_HOME' } } }
    const env = overridden ? { AGENT_HOME: path.join(root, 'elsewhere') } : {}
    const ctx = ctxOf(root, os, env)
    const want = path.join(overridden ? env.AGENT_HOME : path.join(base === 'home' ? ctx.home : ctx.cwd, os === 'darwin' ? '.mac-agent' : 'win-agent'), 'conf')
    assert.deepEqual(resolveLoc(loc, ctx), [want])
    const src = { file: loc, format, keys: s.keys }
    assert.deepEqual(readSrc(src, ctx), { set: false }, 'absent file: unset')
    put(want, WRITE[format](s.doc))
    const r = readSrc(src, ctx)
    assert.equal(r.set, true, JSON.stringify(r))
    assert.equal(r.value, valueOf(s))
    assert.equal(r.where, `${want}#${s.found}`)
    assert.equal(holds({ src, equals: valueOf(s) }, ctx), true)
    assert.equal(holds({ src, equals: 'something else' }, ctx), false)
    const other = { file: { ...loc.perOs[os === 'darwin' ? 'win32' : 'darwin'], env: undefined }, format, keys: s.keys }
    assert.deepEqual(readSrc(other, ctx), { set: false }, "the other OS's place is not read")
    const locked = readSrc(src, { ...ctx, readFile: (p) => { if (p === want) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.readFileSync(p, 'utf8') } })
    assert.ok(locked.error && locked.where === want, `unreadable is an error, not unset: ${JSON.stringify(locked)}`)
    assert.ok(holds({ src }, { ...ctx, readFile: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } }).error, 'holds carries the error')
    if (BROKEN[format]) {
      put(want, BROKEN[format])
      const bad = readSrc(src, ctx)
      assert.ok(bad.error && bad.where === want, `unparsable is an error, not unset: ${JSON.stringify(bad)}`)
    }
  })
}

test('readSrc · env, policy (injected OS reader) and a precedence list: the first set source answers, an error answers too', () => {
  const root = tmpDir('trocar-src-')
  for (const os of ['darwin', 'win32']) {
    const seen = []
    const ctx = ctxOf(root, os, { CERT: 'bundled', EMPTY: '' }, { policy: (spec) => { seen.push(spec); return { set: true, value: 'p', where: 'policy' } } })
    assert.deepEqual(readSrc({ env: 'CERT' }, ctx), { set: true, value: 'bundled', where: 'env:CERT', all: [{ value: 'bundled', where: 'env:CERT' }] })
    assert.deepEqual(readSrc({ env: 'EMPTY' }, ctx), { set: false }, 'an empty variable is unset')
    assert.equal(readSrc({ policy: { [os]: { key: 'k' } } }, ctx).value, 'p')
    assert.deepEqual(seen, [{ key: 'k' }], 'the OS reader gets the spec of this OS')
    assert.deepEqual(readSrc({ policy: { other: { key: 'k' } } }, ctx), { set: false }, 'no spec for this OS: unset')
    const file = { file: { base: 'home', path: 's.json' }, format: 'json', keys: ['env', 'CERT'] }
    assert.equal(readSrc([file, { env: 'CERT' }], ctx).where, 'env:CERT', 'an absent file passes to the next source')
    put(path.join(ctx.home, 's.json'), JSON.stringify({ env: { CERT: 'system' } }))
    assert.equal(readSrc([file, { env: 'CERT' }], ctx).value, 'system', 'the earlier source wins')
    assert.equal(holds({ src: [file, { env: 'CERT' }], equals: 'bundled' }, ctx), false)
    put(path.join(ctx.home, 's.json'), '{')
    assert.ok(readSrc([file, { env: 'CERT' }], ctx).error, 'a broken earlier source is an error, not a pass to the next')
    fs.rmSync(path.join(ctx.home, 's.json'))
  }
})

test('resolveLoc · glob matches one directory level, sorted; env override with ~; abs; missing base or OS names nothing', () => {
  const root = tmpDir('trocar-src-')
  const ctx = ctxOf(root, 'darwin', { CFG: '~/cfg' })
  const ext = path.join(ctx.home, '.vscode', 'extensions')
  for (const n of ['moonshot-ai.kimi-code-0.9.0', 'moonshot-ai.kimi-code-0.8.1', 'other.ext-1']) fs.mkdirSync(path.join(ext, n), { recursive: true })
  assert.deepEqual(resolveLoc({ base: 'home', path: '.vscode/extensions', glob: 'moonshot-ai.kimi-code-*' }, ctx), ['moonshot-ai.kimi-code-0.8.1', 'moonshot-ai.kimi-code-0.9.0'].map((n) => path.join(ext, n)))
  assert.deepEqual(resolveLoc({ base: 'home', dir: '.agent', path: 'x.json', env: 'CFG' }, ctx), [path.join(ctx.home, 'cfg', 'x.json')])
  assert.deepEqual(resolveLoc({ base: 'abs', path: path.join(root, 'abs.json') }, ctx), [path.join(root, 'abs.json')])
  assert.deepEqual(resolveLoc({ base: 'appSupport', path: 'Code/User/settings.json' }, ctx), [path.join(ctx.dirs.appSupport, 'Code', 'User', 'settings.json')])
  assert.deepEqual(resolveLoc({ base: 'localAppData', path: 'x' }, { ...ctx, dirs: {} }), [])
  assert.deepEqual(resolveLoc({ perOs: { win32: { base: 'home', path: 'x' } } }, ctx), [])
  const gone = { ...ctx, readdir: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }) } }
  assert.deepEqual(readSrc({ file: { base: 'home', path: 'nowhere', glob: '*' }, format: 'json', keys: ['a'] }, gone), { set: false }, 'a glob over a missing directory: unset')
})

test('isPresent · any loc exists (glob included) or a command resolves through the injected which', () => {
  const root = tmpDir('trocar-src-')
  const ctx = ctxOf(root, 'win32', {}, { which: (c) => (c === 'kimi' ? '/x/kimi' : null), readdir: (p) => { try { return fs.readdirSync(p) } catch (e) { if (e.code === 'ENOENT') return []; throw e } } })
  const glob = { base: 'home', path: '.vscode/extensions', glob: 'openai.chatgpt-*' }
  assert.equal(isPresent({ present: [glob, { command: 'codex' }] }, ctx), false)
  assert.equal(isPresent({ present: [glob, { command: 'kimi' }] }, ctx), true)
  fs.mkdirSync(path.join(ctx.home, '.vscode', 'extensions', 'openai.chatgpt-26.1'), { recursive: true })
  assert.equal(isPresent({ present: [glob] }, ctx), true)
  assert.equal(isPresent({ present: [{ perOs: { darwin: { base: 'home', path: '.vscode' } } }] }, ctx), false, 'a place of the other OS')
  assert.equal(isPresent({ present: [{ perOs: { win32: { base: 'home', path: '.vscode' } } }] }, ctx), true)
})

test('yaml · the smallest reader: comments, quotes, nested maps, lists of scalars and maps; anything else is an error', () => {
  const root = tmpDir('trocar-src-')
  const ctx = ctxOf(root, 'darwin')
  const f = path.join(ctx.home, 'c.yaml')
  const read = (text, keys) => { put(f, text); return readSrc({ file: { base: 'home', path: 'c.yaml' }, format: 'yaml', keys }, ctx) }
  const doc = '# top\nmodel:\n  default: "a # not a comment"\n  list:\n    - one\n    - \'two\'\nroutes:\n- name: r1 # trailing\n  ssl_ca_cert: /x/ca.pem\n-\n  name: r2\n'
  assert.equal(read(doc, ['model', 'default']).value, 'a # not a comment')
  assert.equal(read(doc, ['model', 'list', '1']).value, 'two')
  assert.deepEqual(read(doc, ['routes', '*', 'name']).all.map((x) => x.value), ['r1', 'r2'])
  assert.equal(read(doc, ['routes', '*', 'ssl_ca_cert']).value, '/x/ca.pem')
  assert.deepEqual(read('', ['a']), { set: false })
  for (const bad of ['a: [1,\n  2]\n', 'a: [&x 1]\n', 'a: {b: *x}\n', 'a: [x] rest\n', 'a: {b}\n', 'a: |\n  text\n', 'a: &x 1\n', 'a:\n\tb: 1\n', 'a: 1\n  b: 2\n', 'a: 1\nb\n', '- a\nb: 1\n']) {
    assert.ok(read(bad, ['a']).error, `not read as YAML this reader knows: ${JSON.stringify(bad)}`)
  }
})

// flow leaves: one-line flow collections × where they sit (a top-level list item, a map value) × read through '*'; the measured seed is the row
// trocar itself writes into dsh's cordis.patch.yml (the Windows overlay's inject at 60c8d165, since deleted; the Linux descriptor's inject writes the same flow form), comment and all.
const FLOWS = [
  ['[{id: trocar-ca, name: ./trocar-ca.mjs}]', [{ id: 'trocar-ca', name: './trocar-ca.mjs' }]],
  ['[a, "b, c", \'d\'\'e\']', ['a', 'b, c', "d'e"]],
  ['{k: [x, {y: "}"}], z: w}', { k: ['x', { y: '}' }], z: 'w' }],
  ['[ ]', []],
  ['{}', {}],
]
for (const [flowText, want] of FLOWS) for (const at of ['list', 'map']) {
  test(`yaml · flow leaf ${flowText} · under a ${at} · '*' key path`, () => {
    const root = tmpDir('trocar-src-')
    const ctx = ctxOf(root, 'darwin')
    const f = path.join(ctx.home, 'c.yml')
    put(f, at === 'list' ? `- other: 1\n- insert: ${flowText} # trocar: a comment\n` : `p0:\n  other: 1\np1:\n  insert: ${flowText}\n`)
    const r = readSrc({ file: { base: 'home', path: 'c.yml' }, format: 'yaml', keys: ['*', 'insert'] }, ctx)
    assert.equal(r.error, undefined)
    assert.deepEqual(r.value, want)
  })
}
