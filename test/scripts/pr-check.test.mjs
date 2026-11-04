// test/scripts/pr-check.test.mjs — scripts/pr-check.mjs on a temp repo and a temp HOME (spec 1.12 §6, AN15-AN25).
//
// Every token, home path and machine name here is put together at run time, and what must pass carries FAKE or a neutral name: the
// outbound checks of this very repository read this file too.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { envLine, writeSegment } from '../query/raw-home.mjs'
import { bigSession } from '../query/big-session.mjs'
import { request, serveFace, withToken } from '../server/face.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/pr-check.mjs', import.meta.url))
const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))
const BEFORE = '2026-11-01T00:00:00.000Z'
const NOREPLY = '1+nobody@users.noreply.github.com'
const WHERE = /^[0-9a-f]{7,}(:file#\d+(:\d+)?|:message|:author)?$|^(title|body|branch|git|capture)$/
const WHY_BODY = 'subject\n\nThe reason for this change.\n'

/** A repo on branch `work`, one commit past tag `base`'s `files`, and a HOME with no capture in it. */
function workspace(files = {}) {
  const home = tmpDir('trocar-prc-home-'), dir = tmpDir('trocar-prc-repo-'), texts = tmpDir('trocar-prc-text-')
  const config = path.join(home, 'gitconfig')
  fs.writeFileSync(config, '')
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Anon Author', GIT_AUTHOR_EMAIL: NOREPLY, GIT_COMMITTER_NAME: 'Anon Author', GIT_COMMITTER_EMAIL: NOREPLY }
  const git = (args, extra = {}) => {
    const r = spawnSync('git', args, { cwd: dir, env: { ...env, ...extra } })
    assert.equal(r.status, 0, r.stderr.toString())
    return r.stdout.toString()
  }
  const commit = (changes = {}, message = WHY_BODY, extra = {}) => {
    for (const [name, bytes] of Object.entries(changes)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      fs.writeFileSync(path.join(dir, name), bytes)
    }
    git(['add', '-A'])
    git(['commit', '-q', '--allow-empty', '-m', message], extra)
  }
  const check = ({ title = 'A title', body = 'A body', args = [], env: extra = {}, cwd = dir, base = ['--base', 'base'], before = BEFORE } = {}) => {
    const titleFile = path.join(texts, 'title'), bodyFile = path.join(texts, 'body')
    fs.writeFileSync(titleFile, title)
    fs.writeFileSync(bodyFile, body)
    const r = spawnSync(process.execPath, [SCRIPT, '--json', '--before', before, '--title', titleFile, '--body', bodyFile, ...base, ...args],
      { cwd, env: { ...env, ...extra }, maxBuffer: 2 ** 28 })
    return { code: r.status, doc: JSON.parse(r.stdout.toString()) }
  }
  git(['init', '-q', '-b', 'main'])
  commit({ 'README.md': 'A readme.\n', ...files }, 'base\n\nThe base.\n')
  git(['tag', 'base'])
  git(['checkout', '-q', '-b', 'work'])
  return { home, dir, env, git, commit, check, trocar: path.join(home, '.trocar') }
}

const of = (doc, rule) => doc.findings.filter((f) => f.rule === rule)
/** The paths `rule` named, read through `leaving.files` the way a person would. */
const named = (doc, rule) => [...new Set(of(doc, rule).map((f) => doc.leaving.files[/:file#(\d+)/.exec(f.where)?.[1]]).filter(Boolean))].sort()
const shapely = (doc) => doc.findings.forEach((f) => assert.match(f.where, WHERE))
const sorted = (o) => Object.keys(o).sort()

/** The ways one word can be written in a text. Every spelling normalizes to the word. */
const spellings = (word) => ({
  exact: word,
  upper: word.toUpperCase(),
  escaped: JSON.stringify(word).slice(1, -1).replaceAll('/', '\\/'),
  unicode: [...word].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  split: `${word.slice(0, word.length >> 1)}\n${word.slice(word.length >> 1)}`,
})
/** One file per spelling of each word, under `dir/`. */
const planted = (words, dir = 'plant') => Object.fromEntries(Object.entries(words).flatMap(([kind, word]) =>
  Object.entries(spellings(word)).map(([how, text]) => [`${dir}/${kind}-${how}.txt`, `${text}\n`])))

// ── AN15
test('AN15: a missing option, a bad time or a bad budget is exit 2, and nothing was read', () => {
  const w = workspace()
  const text = path.join(w.home, 'text')
  fs.writeFileSync(text, 'x')
  const before = ['--before', BEFORE], title = ['--title', text], body = ['--body', text]
  for (const args of [[...title, ...body], [...before, ...title], [...before, ...body], ['--issue', ...before], ['--issue', ...body],
    ['--before', 'not a time', ...title, ...body], [...before, ...title, ...body, '--budget', 'lots'], [...before, ...title, ...body, '--frob'],
    [...before, ...title, '--body', path.join(w.home, 'no-such-file')]]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: w.dir, env: w.env })
    assert.equal(r.status, 2, args.join(' '))
    assert.equal(r.stdout.length, 0)
    assert.equal(fs.existsSync(w.trocar), false, 'no query ran')
  }
})

// ── AN16
const BLOCKED = ['.png', '.JPG', '.jpeg', '.gif', '.webp', '.mp4', '.mov', '.webm', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.ndjson', '.sealed', '.har', '.pcap']
test('AN16: every blocked type and every file git calls binary is refused, an edit too; text and SVG pass', () => {
  const w = workspace({ 'old.png': 'x\n', 'gone.png': 'x\n' })
  fs.rmSync(path.join(w.dir, 'gone.png'))
  const blocked = Object.fromEntries(BLOCKED.map((ext, i) => [`assets/f${i}${ext}`, 'text\n']))
  w.commit({ ...blocked, 'old.png': 'y\n', 'data.dat': Buffer.from([1, 0, 2, 0, 3]), 'notes.md': 'text\n', 'icon.svg': '<svg/>\n', 'test/fixtures/x.ndjson': '{}\n' })
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'files'), [...Object.keys(blocked), 'data.dat', 'old.png', 'test/fixtures/x.ndjson'].sort())
  shapely(doc)
  assert.ok(doc.leaving.files.includes('notes.md') && !doc.leaving.files.includes('gone.png'))
})

for (const [name, script, code] of [['a rebuild that matches passes', 'node -e 0', 0], ['a rebuild that does not match is refused', 'node -e process.exit(1)', 1]]) {
  test(`AN16: src/web/board/**: ${name}`, () => {
    const w = workspace({ 'package.json': JSON.stringify({ scripts: { 'test:build': script } }) })
    w.commit({ 'src/web/board/logo.png': 'x\n' })
    const r = w.check()
    assert.equal(r.code, code)
    assert.equal(of(r.doc, 'files').length, code)
  })
}

// ── AN17
const MIXED = 'aB3dE5gH7j'.repeat(5)
const tokens = (mark) => ({
  anthropic: `sk-ant-api03-${mark}${MIXED}`, plain: `sk-${mark}${MIXED}`, ghp: `ghp_${mark}${MIXED}`, gho: `gho_${mark}${MIXED}`, ghs: `ghs_${mark}${MIXED}`,
  slack: `xoxb-${mark}1234567890-abcdef`, aws: `AKIA${(mark + 'ABCD2345EFGH6789').slice(0, 16)}`,
  jwt: `eyJ${mark}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456${mark}`,
  pem: `-----BEGIN ${mark ? `${mark} ` : ''}RSA PRIVATE KEY-----`,
  authorization: `Authorization: Bearer ${mark}abcdef123456`, escaped: `\\"authorization\\":\\"${mark}abcdef123456\\"`, apikey: `x-api-key: ${mark}abcdef123456`,
  entropy: `${MIXED.slice(0, 40 - mark.length)}${mark}`,
})
const files = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`s/${k}.txt`, `${v}\n`]))

test('AN17: each credential shape is refused, in a file and in the body; carrying FAKE it passes', () => {
  const w = workspace()
  const real = tokens('')
  w.commit(files(real))
  const { code, doc } = w.check({ body: `see ${real.ghp}` })
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'secrets'), sorted(files(real)))
  assert.ok(of(doc, 'secrets').some((f) => f.where === 'body'))
  shapely(doc)

  const v = workspace()
  v.commit(files(tokens('FAKE')))
  assert.deepEqual(of(v.check().doc, 'secrets'), [])
})

test('AN17: what only looks like a credential passes', () => {
  const w = workspace()
  w.commit(files({ variable: 'Authorization: Bearer $TOKEN', placeholder: 'Authorization: <token>', template: 'x-api-key: {key}', masked: 'x-api-key: ***', short: 'x-api-key: abc123',
    just_under: MIXED.slice(0, 39), hex: 'a1b2c3d4e5'.repeat(6), url: 'https://github.com/Bug-001/trocar/releases/latest/download/install', words: 'Not a secret at all.' }))
  assert.deepEqual(of(w.check().doc, 'secrets'), [])
})

test('AN17: the lock\'s integrity and src/web/board/** skip the entropy rule, not the token shapes', () => {
  const w = workspace({ 'package.json': JSON.stringify({ scripts: { 'test:build': 'node -e 0' } }) })
  w.commit({ 'package-lock.json': `{"integrity": "sha512-${MIXED}"}\n`, 'src/web/board/app.js': `${MIXED}\n` })
  assert.deepEqual(of(w.check().doc, 'secrets'), [])
  w.commit({ 'package-lock.json': `{"resolved": "${MIXED}"}\n`, 'src/web/board/app.js': `ghp_${MIXED}\n` })
  assert.deepEqual(named(w.check().doc, 'secrets'), ['package-lock.json', 'src/web/board/app.js'])
})

// ── AN18
const homes = (x) => ({ mac: ['', 'Users', x, ''].join('/'), linux: ['', 'home', x, ''].join('/'), windows: ['C:', 'Users', x, ''].join('\\') })
const pathSpellings = (p) => ({ plain: p, upper: p.toUpperCase(), json: JSON.stringify(p).slice(1, -1), slashes: p.replaceAll('/', '\\/'),
  unicode: p.replace(/[/\\]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) })
const homeFiles = (x) => Object.fromEntries(Object.entries(homes(x)).flatMap(([form, p]) =>
  Object.entries(pathSpellings(p)).map(([how, text]) => [`h/${form}-${how}.txt`, `path ${text}file\n`])))

test('AN18: a home path in any spelling is refused; a neutral name or a placeholder passes', () => {
  const w = workspace()
  const real = homeFiles('zorgon7')
  w.commit(real)
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'identity'), sorted(real))
  shapely(doc)

  const v = workspace()
  for (const x of ['me', 'you', 'user', 'alice', 'bob', 'test', 'runner', 'someone', 'Alice', '$USER', '<name>', '{name}', '*', '${name}']) v.commit(homeFiles(x))
  assert.deepEqual(of(v.check().doc, 'identity'), [])
})

test('AN18: the machine\'s names in any spelling are refused; the git name only outside the author field', () => {
  const w = workspace()
  w.git(['config', 'user.name', 'Wil Quimby'])
  const host = os.hostname()
  const words = { username: os.userInfo().username, host, hostpart: host.split('.')[0], user: 'zorgon7', logname: 'qlogname8', winuser: 'qwinuser9', computer: 'QCOMPUTER3', gitname: 'Wil Quimby' }
  const env = { USER: words.user, LOGNAME: words.logname, USERNAME: words.winuser, COMPUTERNAME: words.computer, GIT_AUTHOR_NAME: 'Wil Quimby', GIT_COMMITTER_NAME: 'Wil Quimby' }
  const plant = planted(words)
  w.commit(plant, WHY_BODY, env)
  const { code, doc } = w.check({ env, title: `about ${words.user}` })
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'identity'), sorted(plant))
  assert.ok(of(doc, 'identity').some((f) => f.where === 'title'))
  assert.ok(!of(doc, 'identity').some((f) => f.where.endsWith(':author')))
  shapely(doc)
})

test('AN18: a machine name in the author field is refused unless it is the GitHub login in the noreply address', () => {
  const w = workspace()
  w.commit({}, WHY_BODY, { GIT_AUTHOR_NAME: 'Zorgon Seven', GIT_AUTHOR_EMAIL: '2+qlogin5@users.noreply.github.com' })
  assert.deepEqual(of(w.check({ env: { USER: 'qlogin5' } }).doc, 'identity'), [])
  assert.equal(of(w.check({ env: { USER: 'zorgon' } }).doc, 'identity').length, 1)
})

for (const [name, email, code] of [['a user noreply address', '2+x@users.noreply.github.com', 0], ['GitHub\'s own', 'noreply@github.com', 0], ['any other address', 'zorgon@example.com', 1]]) {
  for (const field of ['AUTHOR', 'COMMITTER']) {
    test(`AN18: ${field} email: ${name}`, () => {
      const w = workspace()
      w.commit({}, WHY_BODY, { [`GIT_${field}_EMAIL`]: email })
      const r = w.check()
      assert.equal(r.code, code)
      assert.equal(of(r.doc, 'identity').length, code)
      if (code) assert.match(of(r.doc, 'identity')[0].where, /^[0-9a-f]+:author$/)
    })
  }
}

// ── AN21
const lines = (n) => 'x\n'.repeat(n)
test('AN21: more than 400 changed lines is refused; deletions count, the excluded paths do not', () => {
  const w = workspace({ 'old.txt': lines(1) })
  w.commit({ 'a.txt': lines(399), 'old.txt': '' })
  assert.deepEqual(w.check().doc.findings, [], '399 added and 1 deleted is exactly 400')
  w.commit({ 'package-lock.json': lines(500), 'pkg/package-lock.json': lines(500), 'test/fixtures/x.txt': lines(500), 'src/web/board/x.txt': lines(500) })
  assert.deepEqual(of(w.check().doc, 'shape'), [])
  w.commit({ 'b.txt': lines(401) })
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.equal(of(doc, 'shape').length, 1)
  shapely(doc)
})

for (const [name, message, code] of [['subject only', 'subject\n', 1], ['subject and trailers', 'subject\n\nCo-Authored-By: A <a@example.com>\nSigned-off-by: A <a@example.com>\n', 1],
  ['a body', WHY_BODY, 0], ['a body and trailers', `${WHY_BODY}\nCo-Authored-By: A <a@example.com>\n`, 0], ['a body that looks like a trailer, then trailers', 'subject\n\nNote: why.\n\nCo-Authored-By: A <a@example.com>\n', 0]]) {
  test(`AN21: message with ${name}`, () => {
    const w = workspace()
    w.commit({}, message)
    const r = w.check()
    assert.equal(r.code, code)
    assert.equal(of(r.doc, 'shape').length, code)
  })
}

test('AN21: control bytes in a file or a message are refused; tab, newline and escape pass', () => {
  const w = workspace()
  w.commit({ 'bad.txt': 'a\n\x01b\n', 'fine.txt': 'a\tb\x1b\n' }, `subject \x07\n\nThe reason.\n`)
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'shape'), ['bad.txt'])
  assert.ok(of(doc, 'shape').some((f) => /:file#\d+:2$/.test(f.where)), 'the line of the new file')
  assert.ok(of(doc, 'shape').some((f) => f.where.endsWith(':message')))
})

test('a rename, a mode change and an awkward name are read as themselves', () => {
  const w = workspace({ 'old.txt': lines(500), 'run.sh': 'x\n' })
  w.git(['mv', 'old.txt', 'new.txt'])
  fs.chmodSync(path.join(w.dir, 'run.sh'), 0o755)
  w.commit({ 'with space/naïve "q".txt': 'x\n' })
  const { code, doc } = w.check()
  assert.equal(code, 0, JSON.stringify(doc.findings))
  assert.deepEqual(doc.leaving.files.sort(), ['new.txt', 'run.sh', 'with space/naïve "q".txt'])
})

test('a merge commit brings its message only, and needs no body', () => {
  const w = workspace()
  w.git(['checkout', '-q', '-b', 'side', 'base'])
  w.commit({ 'side.txt': 'side\n' })
  w.git(['checkout', '-q', 'work'])
  w.commit({ 'work.txt': 'work\n' })
  w.git(['merge', '-q', '--no-ff', '-m', 'Merge side', 'side'])
  const { code, doc } = w.check()
  assert.equal(code, 0, JSON.stringify(doc.findings))
  assert.equal(doc.leaving.commits.length, 3)
  assert.deepEqual(doc.leaving.files, ['side.txt', 'work.txt'])
})

// ── AN24
test('AN24: changing any outbound byte moves the hash, and a re-run does not', () => {
  const w = workspace()
  const text = { title: 'A title', body: 'A body' }
  w.commit({ 'a.txt': 'one\n' })
  const hash = (o = {}) => w.check({ ...text, ...o }).doc.hash
  const first = hash()
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(hash({ before: '2026-11-02T00:00:00Z', args: ['--budget', '1'] }), first, 'not an outbound byte')
  assert.notEqual(hash({ title: 'A titlf' }), first)
  assert.notEqual(hash({ body: 'A bodz' }), first)
  const moved = (change) => { const before = hash(); change(); assert.notEqual(hash(), before) }
  moved(() => w.git(['branch', '-m', 'work', 'other']))
  moved(() => w.git(['commit', '-q', '--amend', '-m', `${WHY_BODY}more\n`]))
  moved(() => w.git(['commit', '-q', '--amend', '--no-edit', '--reset-author'], { GIT_AUTHOR_NAME: 'Anon Authos' }))
  moved(() => w.commit({ 'a.txt': 'onf\n' }))
})
