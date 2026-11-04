// test/scripts/pr-check.test.mjs — scripts/pr-check.mjs on a temp repo and a temp HOME (spec 1.12 §6, AN15-AN25, AN28-AN31).
//
// Every token, home path and machine name here is put together at run time, and what must pass carries FAKE or a neutral name: the
// outbound checks of this very repository read this file too.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { envLine, writeSegment } from '../query/raw-home.mjs'
import { bigSession } from '../query/big-session.mjs'
import { shapeResponse } from '../../src/collector/core/record/body.mjs'
import { buildWsEnvelope } from '../../src/collector/core/record/envelope.mjs'
import { request, serveFace, withToken } from '../server/face.mjs'
import { callOf } from '../../scripts/lib/trocar-cli.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/pr-check.mjs', import.meta.url))
const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))
const BEFORE = '2026-11-01T00:00:00.000Z'
const NOREPLY = '1+nobody@users.noreply.github.com'
const WHERE = /^[0-9a-f]{7,}(:file#\d+(:\d+)?|:message|:author)?$|^tree:file#\d+(:\d+)?$|^(title|body|branch|git|capture)$/
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
  const check = ({ title = 'A title', body = 'A body', args = [], env: extra = {}, cwd = dir, base = ['--base', 'base'], before = BEFORE, script = SCRIPT, cli = ['--cli', BIN] } = {}) => {
    const titleFile = path.join(texts, 'title'), bodyFile = path.join(texts, 'body')
    fs.writeFileSync(titleFile, title)
    fs.writeFileSync(bodyFile, body)
    const r = spawnSync(process.execPath, [script, '--json', '--before', before, '--title', titleFile, '--body', bodyFile, ...base, ...cli, ...args],
      { cwd, env: { ...env, ...extra }, maxBuffer: 2 ** 28 })
    return { code: r.status, doc: JSON.parse(r.stdout.toString()) }
  }
  git(['init', '-q', '-b', 'main'])
  commit({ 'README.md': 'A readme.\n', ...files }, 'base\n\nThe base.\n')
  git(['tag', 'base'])
  git(['checkout', '-q', '-b', 'work'])
  return { home, dir, env, git, commit, check, trocar: path.join(home, '.trocar') }
}

/** `w`'s repo made the check's own clone: the check sits in it, what it imports is linked in, and none of that is tracked. */
function adopt(w) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  fs.cpSync(path.join(root, 'scripts/lib'), path.join(w.dir, 'scripts/lib'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(w.dir, 'scripts/pr-check.mjs'))
  const links = ['src/query', 'src/raw', 'src/dissect', 'src/view', 'src/capture']
  for (const link of links) {
    fs.mkdirSync(path.dirname(path.join(w.dir, link)), { recursive: true })
    fs.symlinkSync(path.join(root, link), path.join(w.dir, link), 'junction')
  }
  fs.appendFileSync(path.join(w.dir, '.git/info/exclude'), `scripts\n${links.join('\n')}\n`)
  return path.join(w.dir, 'scripts/pr-check.mjs')
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
test('AN15: a missing option, a bad time or a CLI that is not there is exit 2, and nothing was read', () => {
  const w = workspace()
  const text = path.join(w.home, 'text')
  fs.writeFileSync(text, 'x')
  const before = ['--before', BEFORE], title = ['--title', text], body = ['--body', text]
  for (const args of [[...title, ...body], [...before, ...title], [...before, ...body], ['--issue', ...before], ['--issue', ...body],
    ['--before', 'not a time', ...title, ...body], [...before, ...title, ...body, '--frob'],
    [...before, ...title, '--body', path.join(w.home, 'no-such-file')], [...before, ...title, ...body, '--cli', path.join(w.home, 'no-such-cli')]]) {
    const r = spawnSync(process.execPath, [SCRIPT, '--cli', BIN, ...args], { cwd: w.dir, env: w.env })
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
    const own = adopt(w)
    w.commit({ 'src/web/board/logo.png': 'x\n' })
    const r = w.check({ script: own })
    assert.equal(r.code, code)
    assert.equal(of(r.doc, 'files').length, code)
  })
}

test('AN16: of two commits to one board binary only the one HEAD holds goes out', () => {
  const w = workspace({ 'package.json': JSON.stringify({ scripts: { 'test:build': 'node -e 0' } }) })
  const own = adopt(w)
  w.commit({ 'src/web/board/logo.png': 'first\n' })
  w.commit({ 'src/web/board/logo.png': 'second\n' })
  const { code, doc } = w.check({ script: own })
  assert.equal(code, 1)
  assert.deepEqual(of(doc, 'files').map((f) => f.where), [`${doc.leaving.commits[0].sha}:file#0`])
})

test('AN16: an SVG whose new lines embed an image is refused as one; a plain SVG is text', () => {
  const w = workspace({ 'old.svg': '<svg><image href="x"/></svg>\n' })
  const embedding = { 'a.svg': '<svg><image href="x"/></svg>\n', 'b.svg': '<svg><a href="data:text/plain,x"/></svg>\n', 'c.SVG': '<svg><IMAGE href="x"/></svg>\n', 'd.svg': '<svg><a href="DATA:text/plain,x"/></svg>\n' }
  w.commit({ ...embedding, 'plain.svg': '<svg/>\n', 'old.svg': '<svg><image href="x"/></svg>\n<!-- end -->\n', 'imagery.svg': '<svg><imagery/></svg>\n' })
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'files'), sorted(embedding))
})

const DATA_URI = ['data', 'image/png;base64,AAAA'].join(':')
const IMAGES = { 'a data URI': DATA_URI, 'a Markdown image': '![x](u)', 'a Markdown image by reference': '![x][r]', 'an img tag': '<img src=u>', 'an IMG tag': '<IMG SRC=u>' }

test('AN16: a data URI of an image is refused in any committed text, in every spelling', () => {
  const w = workspace()
  const spelled = Object.fromEntries(Object.entries(spellings(DATA_URI)).filter(([how]) => how !== 'split').map(([how, text]) => [`spelled/${how}.txt`, `${text}\n`]))
  const files = { 'a.md': `before ${DATA_URI} after\n`, 'a.html': `<a href="${DATA_URI}">x</a>\n`, ...spelled }
  w.commit({ ...files, 'plain.md': 'dataImage and data:text/plain are not images\n' }, `subject\n\nHolds ${DATA_URI} in its body.\n`)
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'files'), sorted(files))
  assert.equal(of(doc, 'files').filter((f) => f.where.endsWith(':message')).length, 1)
  shapely(doc)
})

for (const [name, text] of Object.entries(IMAGES)) {
  test(`AN16: ${name} in a title, a body and a comment is refused, and the same text is public once the base holds it`, () => {
    const w = workspace()
    w.commit({ 'a.txt': 'nothing here\n' })
    const wheres = (r) => { assert.equal(r.code, 1); return of(r.doc, 'files').map((f) => f.where) }
    assert.deepEqual(wheres(w.check({ body: `see ${text} here` })), ['body'])
    assert.deepEqual(wheres(w.check({ title: text })), ['title'])
    assert.deepEqual(wheres(w.check({ body: text, args: ['--issue'] })), ['body'])

    const known = workspace({ 'docs/old.md': `an old line with ${text} in it\n` })
    known.commit({ 'docs/new.md': `${text}\n` })
    const r = known.check({ title: text, body: `see ${text} here` })
    assert.equal(r.code, 0, JSON.stringify(r.doc.findings))
    assert.equal(known.check({ body: text, args: ['--issue'] }).code, 0)
  })
}

test('AN16: a Markdown image or an img tag inside a commit passes', () => {
  const w = workspace()
  w.commit({ 'docs/a.md': '![x](icon.svg)\n<img src=icon.svg>\n' }, 'subject\n\nDraws ![x](icon.svg) and <img src=icon.svg>.\n')
  const { code, doc } = w.check()
  assert.equal(code, 0, JSON.stringify(doc.findings))
})

test('AN16: an image is public only as the same bytes: other words after the same start, or the same letters, do not pass', () => {
  const w = workspace({ 'old.md': `![x](u) <img src=u> ${DATA_URI} xu dataimagepngbase64bbbb\n` })
  w.commit({ 'a.txt': 'nothing here\n' })
  for (const text of ['![x](elsewhere)', '<img src=elsewhere>', `${DATA_URI}BBBB`, '![X](U)', ['data', 'image/png;base64,BBBB'].join(':')]) {
    const r = w.check({ body: text })
    assert.equal(r.code, 1, text)
    assert.deepEqual(of(r.doc, 'files').map((f) => f.where), ['body'], text)
  }
  const short = workspace({ 'old.md': 'xu\n' })
  short.commit({ 'a.txt': 'nothing here\n' })
  assert.equal(short.check({ body: '![x](u)' }).code, 1, 'two letters in the base do not make the image public')
})

test('AN16: src/web/board/** in a clone that is not the check\'s own: nothing of that clone is run, and it is refused', () => {
  const w = workspace({ 'package.json': JSON.stringify({ scripts: { 'test:build': 'node -e "require(\'fs\').writeFileSync(\'ran\',\'\')"' } }) })
  w.commit({ 'src/web/board/logo.png': 'x\n' })
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'files'), ['src/web/board/logo.png'])
  assert.equal(fs.existsSync(path.join(w.dir, 'ran')), false)
})

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
  const tabbed = process.platform === 'win32' ? [] : ['tab\tname.txt'] // Windows has no such file name
  w.commit({ 'with space/naïve "q".txt': 'x\n', ...Object.fromEntries(tabbed.map((name) => [name, 'x\n'])) })
  const { code, doc } = w.check()
  assert.equal(code, 0, JSON.stringify(doc.findings))
  assert.deepEqual(doc.leaving.files.sort(), ['new.txt', 'run.sh', ...tabbed, 'with space/naïve "q".txt'])
})

// git prints such a change as two diffs of one path and numstat as one row
const TYPECHANGED = ['plain.txt', 'with space/naïve "q".txt', ...(process.platform === 'win32' ? [] : ['tab\tname.txt'])]
for (const [name, swap] of Object.entries({
  'a file that becomes a link': (at) => { fs.rmSync(at); fs.symlinkSync('x/zorgon7/y', at) },
  'a link that becomes a file': (at) => { fs.rmSync(at); fs.writeFileSync(at, 'x/zorgon7/y\n') },
})) {
  test(`${name}, under any name, is read as itself`, { skip: process.platform === 'win32' }, () => {
    const w = workspace(Object.fromEntries(TYPECHANGED.map((file) => [file, 'x\n'])))
    if (name.startsWith('a link')) {
      for (const file of TYPECHANGED) { fs.rmSync(path.join(w.dir, file)); fs.symlinkSync('elsewhere', path.join(w.dir, file)) }
      w.commit()
      w.git(['tag', '-f', 'base'])
    }
    for (const file of TYPECHANGED) swap(path.join(w.dir, file))
    w.commit({ 'after.txt': 'x\n' })
    const clean = w.check()
    assert.equal(clean.code, 0, JSON.stringify(clean.doc.findings))
    assert.deepEqual(clean.doc.leaving.files.sort(), ['after.txt', ...TYPECHANGED].sort())
    const { doc } = w.check({ env: { USER: 'zorgon7' } })
    assert.deepEqual(named(doc, 'identity'), [...TYPECHANGED].sort(), 'what the path holds now was read')
  })
}

test('AN21: a merge commit in the branch is refused by its own sha', () => {
  const w = workspace()
  w.git(['checkout', '-q', '-b', 'side', 'base'])
  w.commit({ 'side.txt': 'side\n' })
  w.git(['checkout', '-q', 'work'])
  w.commit({ 'work.txt': 'work\n' })
  w.git(['merge', '-q', '--no-ff', '-m', 'Merge side', 'side'])
  const sha = w.git(['rev-parse', 'HEAD']).trim()
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.ok(of(doc, 'shape').some((f) => /^[0-9a-f]{7,}$/.test(f.where) && sha.startsWith(f.where)), JSON.stringify(doc.findings))
  shapely(doc)
})

// ── AN24
test('AN24: changing any outbound byte moves the hash, and a re-run does not', () => {
  const w = workspace()
  const text = { title: 'A title', body: 'A body' }
  w.commit({ 'a.txt': 'one\n' })
  const hash = (o = {}) => w.check({ ...text, ...o }).doc.hash
  const first = hash()
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.notEqual(hash({ before: '2026-11-02T00:00:00Z' }), first, 'the terms it was judged on')
  assert.notEqual(hash({ args: ['--accept-partial'] }), first, 'the terms it was judged on')
  assert.notEqual(hash({ title: 'A titlf' }), first)
  assert.notEqual(hash({ body: 'A bodz' }), first)
  const moved = (change) => { const before = hash(); change(); assert.notEqual(hash(), before) }
  moved(() => w.git(['branch', '-m', 'work', 'other']))
  moved(() => w.git(['commit', '-q', '--amend', '-m', `${WHY_BODY}more\n`]))
  moved(() => w.git(['commit', '-q', '--amend', '--no-edit', '--reset-author'], { GIT_AUTHOR_NAME: 'Anon Authos' }))
  moved(() => w.commit({ 'a.txt': 'onf\n' }))
})

const VALUE_A = 'a'.repeat(64), VALUE_B = 'b'.repeat(64)
test('AN24: the line the PR template leaves for the hash does not move it, and anything else on that line does', () => {
  const w = workspace()
  w.commit({ 'a.txt': 'one\n' })
  const template = fs.readFileSync(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8')
  const row = template.split('\n').find((r) => r.includes('node scripts/pr-check.mjs'))
  const hash = (written) => w.check({ body: `Before\n${written}\nAfter\n` }).doc.hash
  const first = hash(`${row} ${VALUE_A}`)
  for (const written of [`${row} ${VALUE_B}`, `${row} \`${VALUE_B}\``, `${row}${VALUE_B}`, row]) assert.equal(hash(written), first, written)
  for (const written of [`${row} ${VALUE_A} and more`, `${row} more`, `${row} ${VALUE_A.slice(1)}`, `${row} \`${VALUE_A}`, `more ${row} ${VALUE_A}`]) assert.notEqual(hash(written), first, written)
})

test('AN24: the hash holds the commit --base resolves to, not the name it was given', () => {
  const w = workspace()
  w.commit({ 'a.txt': 'one\n' })
  w.git(['tag', 'mid'])
  w.git(['tag', 'same', 'mid'])
  w.commit({ 'b.txt': 'two\n' })
  const hash = (ref, args = []) => w.check({ base: ['--base', ref], args }).doc.hash
  assert.equal(hash('same'), hash('mid'))
  assert.notEqual(hash('base'), hash('mid'))
  assert.notEqual(hash('base', ['--issue']), hash('mid', ['--issue']), 'a comment takes nothing from git, so only the base differs')
})

test('AN24: what was compared and what was let through move the hash, whatever the outbound bytes', () => {
  const faulty = (w, rewrite) => {
    const cli = path.join(w.home, 'cli.mjs')
    fs.writeFileSync(cli, `import { spawnSync } from 'node:child_process'
const argv = process.argv.slice(2), real = spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...argv], { maxBuffer: 2 ** 30 })
let out = real.stdout.toString(), code = real.status
${rewrite}
process.stdout.write(out)
process.exitCode = code
`)
    return ['--cli', cli]
  }
  const accept = { args: ['--accept-partial'] }
  const compared = workspace()
  compared.commit({ 'a.txt': 'nothing here\n' })
  const segment = capture(compared, SEGMENT, [line(NOW_THEN, 'nothing shared'), OPAQUE['a line that is not JSON']()])
  const seen = compared.check(accept)
  assert.equal(seen.code, 0)
  const noRaw = compared.check({ ...accept, cli: faulty(compared, `if (argv[0] === 'raw') { out = ''; code = 3 }`) })
  assert.equal(noRaw.code, 0, 'the one flag lets this out too')
  assert.notEqual(noRaw.doc.hash, seen.doc.hash, 'consent to one unopened record is not consent to no comparison at all')
  const noCapture = compared.check({ cli: faulty(compared, `out = JSON.stringify({ ok: true, segments: [], sessions: [], hosts: [] }); code = 0`) })
  assert.equal(noCapture.code, 0)
  assert.notEqual(noCapture.doc.hash, compared.check().doc.hash, 'no capture is not the capture')
  fs.appendFileSync(segment, `${line(NOW_THEN, 'one more')}\n`)
  assert.notEqual(compared.check(accept).doc.hash, seen.doc.hash, 'scanned_bytes')
  fs.appendFileSync(segment, `${OPAQUE['a line that is not JSON']()}\n`)
  const more = compared.check(accept)
  fs.appendFileSync(segment, `${OPAQUE['a line that is not JSON']()}\n`)
  assert.notEqual(compared.check(accept).doc.hash, more.doc.hash, 'opaque_bytes')

  const { w } = pendingTitle()
  w.commit({ 'a.txt': 'one\n' })
  const fine = w.check(accept)
  const fault = `if (argv.includes('--head')) { const d = JSON.parse(out); d.meta.title = null; d.meta.title_source = 'pending'; out = JSON.stringify(d) }`
  const shy = w.check({ ...accept, cli: faulty(w, fault) })
  assert.equal(shy.code, 0)
  assert.deepEqual([shy.doc.coverage.scanned_bytes, shy.doc.coverage.opaque_bytes], [fine.doc.coverage.scanned_bytes, fine.doc.coverage.opaque_bytes])
  assert.notEqual(shy.doc.hash, fine.doc.hash, 'the set let through')
})

// ── AN28
test('AN28: a base that is HEAD or not an ancestor of it is refused; a comment does not judge it', () => {
  const w = workspace()
  w.commit({ 'a.txt': 'one\n' })
  w.git(['checkout', '-q', '-b', 'elsewhere', 'base'])
  w.commit({ 'b.txt': 'two\n' })
  w.git(['checkout', '-q', 'work'])
  assert.deepEqual(of(w.check().doc, 'base'), [])
  for (const ref of ['HEAD', 'elsewhere']) {
    const { code, doc } = w.check({ base: ['--base', ref] })
    assert.equal(code, 1, ref)
    assert.equal(of(doc, 'base').length, 1, ref)
    shapely(doc)
  }
  const reply = w.check({ base: ['--base', 'HEAD'], args: ['--issue'] })
  assert.equal(reply.code, 0, JSON.stringify(reply.doc.findings))
})

const SHARED = 'the same long sentence that also sits in a capture and is here on purpose to fill sixty bytes or more'
test('AN28: a base origin/main does not hold is refused, hides no commit and makes nothing public; one it holds is fine', () => {
  const planted = (setup) => {
    const w = workspace()
    w.git(['update-ref', 'refs/remotes/origin/main', 'base'])
    capture(w, SEGMENT, [line(NOW_THEN, SHARED)])
    setup(w)
    return w
  }
  const inside = planted((w) => { w.commit({ 'a.txt': `${SHARED}\n` }, `${SHARED}\n\nA body.\n`); w.commit({ 'b.txt': 'clean\n' }) })
  const past = inside.check({ base: ['--base', 'HEAD~1'] })
  assert.equal(past.code, 1)
  assert.equal(of(past.doc, 'base').length, 1, 'a commit of the branch is no base')

  const unpushed = planted((w) => { w.commit({ 'a.txt': `${SHARED}\n` }); w.git(['branch', '-f', 'main', 'HEAD']); w.commit({ 'b.txt': `${SHARED}\n` }) })
  const local = unpushed.check({ base: ['--base', 'main'] })
  assert.equal(of(local.doc, 'base').length, 1, 'a local main ahead of origin/main is no base')
  assert.deepEqual(named(local.doc, 'captured-text'), ['b.txt'], 'nothing of its tree counts as public')

  const reply = inside.check({ base: ['--base', 'HEAD'], args: ['--issue'], body: `${SHARED}\n` })
  assert.equal(reply.code, 1)
  assert.deepEqual(reply.doc.findings.map((f) => [f.rule, f.where]), [['captured-text', 'body']], 'a comment judges no base and subtracts no unpublished tree')

  const held = planted((w) => { w.commit({ 'a.txt': 'public\n' }); w.git(['tag', 'mid']); w.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']); w.commit({ 'b.txt': 'mine\n' }) })
  for (const ref of ['origin/main', 'mid', 'base']) assert.equal(held.check({ base: ['--base', ref] }).code, 0, ref)
})

test('AN28: a branch behind origin/main is told to rebase', () => {
  const w = workspace()
  w.commit({ 'a.txt': 'one\n' })
  w.git(['checkout', '-q', '-b', 'ahead', 'base'])
  w.commit({ 'b.txt': 'two\n' })
  w.git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  w.git(['checkout', '-q', 'work'])
  const { code, doc } = w.check({ base: ['--base', 'origin/main'] })
  assert.equal(code, 1)
  assert.match(of(doc, 'base')[0].why, /rebase/i)
  assert.doesNotMatch(of(doc, 'base')[0].why, /--base must/)
})

// ── capture
const SEGMENT = '20261018T100000Z'
const NEWER = '20261020T100000Z'
const line = (ts, text) => JSON.stringify({ ...JSON.parse(envLine({ ts })), req_body: JSON.stringify({ prompt: text }) })
/** `n` normalized bytes of text no other seed shares, in words: ASCII, or Han characters of three bytes each. */
const ascii = (n, seed) => Array.from({ length: n }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[(i * i * 7 + i * seed * 13 + seed * 5) % 26] + (i % 6 === 5 ? ' ' : '')).join('').trim()
const han = (n, seed) => Array.from({ length: n / 3 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 97 + seed * 131) % 5000))).join('')
const escaped = (text) => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
const capture = (w, name, rows) => { fs.mkdirSync(path.join(w.trocar, 'raw'), { recursive: true }); return writeSegment(w.trocar, name, rows) }
const query = (w, ...args) => JSON.parse(spawnSync(process.execPath, [BIN, 'query', ...args], { env: w.env, maxBuffer: 2 ** 28 }).stdout)

// ── AN19
test('AN19: each kind of captured fact is refused in any spelling; a word under four characters is skipped', async () => {
  const w = workspace()
  const s = bigSession({ home: w.trocar, wire: 'http', growth: 600, subEvery: 3, segment: SEGMENT })
  s.append(9)
  capture(w, NEWER, [{ host: 'vault7.example.net' }, { host: 'a.b' }])
  const face = await serveFace({ home: w.trocar })
  try {
    for (const end = Date.now() + 30_000; Date.now() < end;) {
      const { body } = await request(face.port, '/api/sessions', { headers: withToken() })
      if (JSON.parse(body).sessions?.some((row) => row.title_source === 'wire')) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  } finally { face.close() }
  const [row] = query(w, 'sessions').sessions.filter((r) => r.title_source === 'wire')
  assert.ok(row, 'the worker named the session')
  // project_path is null and project_slug a placeholder in every capture for now (src/view/board.mjs), so the path has no value to plant
  assert.equal(row.project_path, null)
  const facts = { project_slug: row.project_slug, session_id: row.session_id, title: row.title, host: 'vault7.example.net', segment: NEWER, record: `${NEWER}:1` }
  const plant = planted(facts)
  w.commit({ ...plant, 'plain.txt': 'nothing here\n', 'short.txt': 'a.b\n' })
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'captured-facts'), sorted(plant))
  shapely(doc)
})

// `query sessions` on a capture no worker has read answers `pending`; `session --head` reads the title itself
const DEMO = fileURLToPath(new URL('../../samples/demo-session.ndjson', import.meta.url))
function pendingTitle() {
  const w = workspace()
  capture(w, SEGMENT, fs.readFileSync(DEMO, 'utf8').split('\n').filter(Boolean))
  const [row] = query(w, 'sessions').sessions
  assert.equal(row.title_source, 'pending')
  const { title } = query(w, 'session', '--id', row.session_id, '--head').meta
  assert.ok(title && Buffer.byteLength(title) < 60, 'a title short enough for captured-text to miss')
  return { w, id: row.session_id, title }
}
test('AN19: a title the list has not read yet is read through the head, and refused', () => {
  const { w, title } = pendingTitle()
  w.commit({ 'a.txt': 'one\n' })
  const { code, doc } = w.check({ body: `Seen in ${title.toUpperCase()}.` })
  assert.equal(code, 1)
  assert.deepEqual(doc.findings.map((f) => [f.rule, f.where]), [['captured-facts', 'body']])
})

// ── AN20
const NOW_THEN = '2026-10-18T10:00:00.000Z'
test('AN20: 60 shared normalized bytes are refused in every spelling, 59 pass, and the coverage is all of it', () => {
  const w = workspace()
  const spelled = {
    ascii: [ascii(60, 1), ascii(60, 1)], upper: [ascii(60, 2).toUpperCase(), ascii(60, 2)], lines: [ascii(60, 3).replaceAll(' ', '\n'), ascii(60, 3)],
    outbound_escapes: [escaped(ascii(60, 4)), ascii(60, 4)], han: [han(60, 5), han(60, 5)], captured_escapes: [han(60, 6), escaped(han(60, 6))], both_escaped: [escaped(han(60, 7)), han(60, 7)],
  }
  const under = { under_ascii: ascii(59, 8), under_han: han(57, 9) }
  const texts = Object.fromEntries(Object.entries(spelled).map(([k, [out]]) => [`t/${k}.txt`, `${out}\n`]))
  w.commit({ ...texts, ...Object.fromEntries(Object.entries(under).map(([k, t]) => [`t/${k}.txt`, `${t}\n`])) })
  const file = capture(w, SEGMENT, [...Object.values(spelled).map(([, captured]) => line(NOW_THEN, captured)), ...Object.values(under).map((t) => line(NOW_THEN, t))])
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'captured-text'), sorted(texts))
  shapely(doc)
  const size = fs.statSync(file).size
  assert.deepEqual(doc.coverage, { scanned_bytes: size, opaque_bytes: 0, after_bytes: 0, total_bytes: size, from: NOW_THEN, to: NOW_THEN })
})

test('AN20: what two commits each bring half of is judged by the tree they leave', () => {
  const text = ascii(80, 1), cut = text.length >> 1
  const halves = (w, name = 'a.txt') => { w.commit({ [name]: `${text.slice(0, cut)}\n` }); w.commit({ [name]: `${text.slice(0, cut)}\n${text.slice(cut)}\n` }) }
  const w = workspace()
  halves(w)
  capture(w, SEGMENT, [line(NOW_THEN, text)])
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'captured-text'), ['a.txt'])
  assert.ok(of(doc, 'captured-text').every((f) => f.where.startsWith('tree:file#')), 'no one commit holds it')
  shapely(doc)
  const whole = workspace()
  whole.commit({ 'a.txt': `${text}\n` })
  whole.commit({ 'b.txt': 'clean\n' })
  capture(whole, SEGMENT, [line(NOW_THEN, text)])
  assert.deepEqual(named(whole.check().doc, 'captured-text'), ['a.txt'])

  const word = workspace()
  word.commit({ 'a.txt': 'zorg\n' })
  word.commit({ 'a.txt': 'zorg\non7\n' })
  assert.deepEqual(named(word.check({ env: { USER: 'zorgon7' } }).doc, 'identity'), ['a.txt'], 'a word the same way')
})

const kept = (o, bytes, coding) => JSON.stringify({ ...JSON.parse(envLine({ ts: NOW_THEN, ...o })), req_body: null, req_body_b64: bytes.toString('base64'), ...(coding ? { req_content_encoding: coding } : {}) })
const prompt = (text) => Buffer.from(JSON.stringify({ prompt: text }))
const CODINGS = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync, zstd: zlib.zstdCompressSync, 'gzip, br': (b) => zlib.brotliCompressSync(zlib.gzipSync(b)) }
test('AN20: a body kept as base64 is compared by what is behind it, whatever hides it, and the coverage counts the record', () => {
  const w = workspace()
  const texts = Object.keys(CODINGS).map((coding, i) => [`t/${i}.txt`, ascii(60, i + 1)])
  const rows = Object.entries(CODINGS).map(([coding, pack], i) => kept({}, pack(prompt(texts[i][1])), coding))
  texts.push(['t/not-text.txt', ascii(60, 20)])
  rows.push(kept({}, Buffer.concat([Buffer.from([0xff, 0xfe]), prompt(ascii(60, 20))])))
  texts.push(['t/not-inference.txt', ascii(60, 21)]) // past the 1 MiB the board reads of a call that is not inference
  rows.push(kept({ is_llm: false }, zlib.zstdCompressSync(prompt(`${' '.repeat(2 ** 21)}${ascii(60, 21)}`)), 'zstd'))
  w.commit({ ...Object.fromEntries(texts.map(([file, text]) => [file, `${text}\n`])), 't/under.txt': `${ascii(59, 22)}\n` })
  const file = capture(w, SEGMENT, [...rows, kept({}, zlib.zstdCompressSync(prompt(ascii(59, 22))), 'zstd')])
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'captured-text'), texts.map(([name]) => name).sort())
  assert.equal(doc.coverage.scanned_bytes, fs.statSync(file).size)
})

// A reply as the collector stores it: a wire's events carry the shared text cut into pieces of 10, so no line holds 60 bytes of it in a row.
const pieces = (text) => text.match(/[^]{1,10}/g)
const events = (list) => list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
const stored = (text, o = {}) => shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(text), ...o })
const reply = (path, resp, o = {}) => JSON.stringify({ ...JSON.parse(envLine({ ts: NOW_THEN, path, ...o })), req_body: '{"model":"m","messages":[]}', resp })
const MESSAGES = '/v1/messages', CHAT = '/v1/chat/completions', RESPONSES = '/v1/responses'
const anthropicDeltas = (key, kind, text) => events([{ type: 'message_start', message: { id: 'm' } }, { type: 'content_block_start', index: 0, content_block: { type: kind, [key]: '' } },
  ...pieces(text).map((piece) => ({ type: 'content_block_delta', index: 0, delta: { type: `${key}_delta`, [key]: piece } })), { type: 'content_block_stop', index: 0 }])
const chatDeltas = (delta, text) => `${events(pieces(text).map((piece) => ({ choices: [{ index: 0, delta: delta(piece) }] })))}data: [DONE]\n\n`
const chatText = (text) => chatDeltas((content) => ({ content }), text)
const toolDelta = (args) => ({ tool_calls: [{ index: 0, function: { arguments: args } }] })
const wsCall = (server, error = null) => JSON.stringify({ ...buildWsEnvelope({ id: 'w1', seq: 1, wsRaw: [], error, flow: { id: 'F', host: 'h', scheme: 'https', dst: {}, proc: {} },
  upgrade: { req: { head: { raw: Buffer.from(''), method: 'GET', target: RESPONSES, headers: [] } }, resp: { head: { raw: Buffer.from(''), headers: [] } } },
  call: { client: ['{"type":"response.create"}'], server, tsStart: NOW_THEN, tsRespStart: NOW_THEN, tsEnd: NOW_THEN, partial: [], truncated: false } }), ts: NOW_THEN })
const textDeltas = (text) => pieces(text).map((delta) => ({ type: 'response.output_text.delta', delta }))
const WIRES = {
  'anthropic text': (text) => reply(MESSAGES, stored(anthropicDeltas('text', 'text', text))),
  'anthropic thinking': (text) => reply(MESSAGES, stored(anthropicDeltas('thinking', 'thinking', text))),
  'chat text': (text) => reply(CHAT, stored(chatText(text))),
  'chat thinking': (text) => reply(CHAT, stored(chatDeltas((reasoning_content) => ({ reasoning_content }), text))),
  'chat tool arguments': (text) => reply(CHAT, stored(chatDeltas(toolDelta, JSON.stringify({ path: text })))),
  'responses cut before its end': (text) => reply(RESPONSES, stored(events(textDeltas(text)))),
  'responses over a WebSocket, cut': (text) => wsCall(textDeltas(text).map((e) => JSON.stringify(e)), { type: 'closed', message: 'gone' }),
  'an error envelope around a chat stream': (text) => reply(CHAT, { status: null, kind: 'error', error: { type: 'reset', message: 'gone' }, partial: stored(chatText(text)) }),
}
/** Files for 60 shared bytes per row, one file of 59 per row that must pass, and the capture; the seeds keep every row's text its own. */
function sharing(rows) {
  const names = Object.keys(rows)
  const over = names.map((name, i) => ascii(60, 1 + i)), under = names.map((name, i) => ascii(59, 14 + i)) // ascii() repeats every 26 seeds
  const refused = Object.fromEntries(names.map((name, i) => [`t/over-${i}.txt`, `${over[i]}\n`]))
  const passing = Object.fromEntries(names.map((name, i) => [`t/under-${i}.txt`, `${under[i]}\n`]))
  return { refused, files: { ...refused, ...passing }, capture: names.flatMap((name, i) => [rows[name](over[i]), rows[name](under[i])]) }
}
test('AN20: a text that only exists once its stream is put together is refused at 60 bytes, on every wire, and passes at 59', () => {
  const w = workspace()
  const { refused, files, capture: rows } = sharing(WIRES)
  w.commit(files)
  const file = capture(w, SEGMENT, rows)
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'captured-text'), sorted(refused))
  assert.equal(doc.coverage.scanned_bytes, fs.statSync(file).size)
  assert.equal(doc.coverage.opaque_bytes, 0)
})

const BIG = ' '.repeat(2 ** 21) // past the 1 MiB the collector expands of a call that is not inference
const packed = (type, text) => shapeResponse({ status: 200, headers: [['content-type', type], ['content-encoding', 'gzip']], body: zlib.gzipSync(text), llm: false })
const COMPRESSED = {
  'a JSON reply': (text) => reply(CHAT, packed('application/json', JSON.stringify({ pad: BIG, answer: text })), { is_llm: false }),
  'a chat stream': (text) => reply(CHAT, packed('text/event-stream', `:${BIG}\n\n${chatText(text)}`), { is_llm: false }),
  'an anthropic stream': (text) => reply(MESSAGES, packed('text/event-stream', `:${BIG}\n\n${anthropicDeltas('text', 'text', text)}`), { is_llm: false }),
}
test('AN20: a reply the collector left compressed is compared by what is behind it', () => {
  const w = workspace()
  const { refused, files, capture: rows } = sharing(COMPRESSED)
  w.commit(files)
  capture(w, SEGMENT, rows)
  assert.ok(rows.every((row) => JSON.parse(row).resp.encoding_error), 'the collector kept the wire bytes')
  const { code, doc } = w.check()
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'captured-text'), sorted(refused))
  assert.equal(doc.coverage.opaque_bytes, 0)
})

test('AN20: a record at or after --before and a segment wholly after it are not compared', () => {
  const w = workspace()
  w.commit({ 'a.txt': `${ascii(60, 1)}\n`, 'b.txt': `${ascii(60, 2)}\n`, 'c.txt': `${ascii(60, 3)}\n`, 'd.txt': `${ascii(60, 4)}\n` })
  const at = line(BEFORE, ascii(60, 2)), later = line('2026-12-01T00:00:00.000Z', ascii(60, 4))
  capture(w, SEGMENT, [line(NOW_THEN, ascii(60, 1)), at, `{"no":"time","text":"${ascii(60, 3)}"}`])
  capture(w, NEWER, [later])
  const { doc } = w.check()
  assert.deepEqual(named(doc, 'captured-text'), ['a.txt', 'c.txt'], 'a record with no time is compared')
  assert.deepEqual([doc.coverage.from, doc.coverage.to], [NOW_THEN, NOW_THEN])
  assert.equal(doc.coverage.after_bytes, Buffer.byteLength(at) + 1 + Buffer.byteLength(later) + 1, 'a record skipped and a segment skipped')
})

// ── AN22
test('AN22: text and words the base already tracks pass; the same ones outside it do not', () => {
  const home = ['', 'Users', 'zorgon7', ''].join('/')
  const w = workspace({ 'docs/old.md': `${ascii(60, 1)}\nvault7.example.net\nzorgon7\n${home}\n` })
  w.commit({ 'known.txt': `${ascii(60, 1)}\nVAULT7.EXAMPLE.NET\nzorgon7\n${home}\n`, 'new.txt': `${ascii(60, 2)}\n` })
  capture(w, SEGMENT, [{ ts: NOW_THEN, host: 'vault7.example.net' }, line(NOW_THEN, ascii(60, 1)), line(NOW_THEN, ascii(60, 2))])
  const { doc } = w.check({ env: { USER: 'zorgon7' } })
  assert.deepEqual(doc.findings.map((f) => [f.rule, doc.leaving.files[/#(\d+)/.exec(f.where)[1]]]), [['captured-text', 'new.txt']])

  const issue = (cwd) => spawnSync(process.execPath, [SCRIPT, '--json', '--issue', '--before', BEFORE, '--body', path.join(w.home, 'reply'), '--base', 'base', '--cli', BIN], { cwd, env: w.env })
  fs.writeFileSync(path.join(w.home, 'reply'), `${ascii(60, 1)}\n`)
  assert.equal(issue(w.dir).status, 0, 'the base subtracts for a comment too')
  const outside = issue(w.home)
  assert.equal(outside.status, 1, 'with no base to read, nothing is subtracted')
  const report = JSON.parse(outside.stdout)
  assert.deepEqual(report.findings.map((f) => [f.rule, f.where]), [['captured-text', 'body']])
  assert.deepEqual(report.leaving, { files: [], commits: [], identity: [], branch: null }, 'a comment takes nothing from git')
})

// ── AN23
test('AN23: findings hold none of the values, not even one that sits in a path', () => {
  const w = workspace()
  const token = `ghp_${MIXED}`, name = 'zorgon7', home = homes('quimby4').mac, host = 'vault7.example.net', text = ascii(60, 1)
  const values = [token, name, 'quimby4', host, text, 'secretfile', 'hidden@example.com', 'hiddenbranch']
  w.git(['branch', '-m', 'work', `feature/${name}-hiddenbranch`])
  w.commit({ [`dir-${name}/${token}.txt`]: 'x\n', [`${host}/secretfile.png`]: 'x\n', 'text.txt': `${home}\n${text}\n${token}\n` }, `about ${host}\n\n${home}\n`, { GIT_AUTHOR_EMAIL: 'hidden@example.com' })
  capture(w, SEGMENT, [{ ts: NOW_THEN, host }, line(NOW_THEN, text)])
  const { code, doc } = w.check({ env: { USER: name }, title: `${name} ${host}`, body: `${home} ${token} ${text}` })
  assert.equal(code, 1)
  assert.deepEqual([...new Set(doc.findings.map((f) => f.rule))].sort(), ['captured-facts', 'captured-text', 'files', 'identity', 'secrets'])
  shapely(doc)
  const printed = JSON.stringify(doc.findings)
  for (const value of values) assert.ok(!printed.toLowerCase().includes(value.toLowerCase()))
})

// ── AN25
test('AN25: no capture at all is an empty comparison, not a failure', () => {
  const w = workspace()
  w.commit({ 'a.txt': `${ascii(60, 1)}\n` })
  const { code, doc } = w.check()
  assert.equal(code, 0, JSON.stringify(doc.findings))
  assert.deepEqual(doc.coverage, { scanned_bytes: 0, opaque_bytes: 0, after_bytes: 0, total_bytes: 0, from: null, to: null })
})

test('AN25: a query that cannot read the capture, a segment that cannot be read, and an unreadable git each refuse', () => {
  const broken = workspace()
  broken.commit({ 'a.txt': 'one\n' })
  fs.writeFileSync(broken.trocar, 'not a folder')
  const query = broken.check()
  assert.equal(query.code, 1)
  assert.deepEqual(query.doc.findings.map((f) => [f.rule, f.where]), [['partial', 'capture']])

  const sealed = workspace()
  sealed.commit({ 'a.txt': `${ascii(60, 1)}\n` })
  fs.mkdirSync(path.join(sealed.trocar, 'raw'), { recursive: true })
  fs.writeFileSync(path.join(sealed.trocar, 'raw', `${SEGMENT}.sealed`), 'this is not a sealed segment')
  const unread = sealed.check()
  assert.equal(unread.code, 1)
  assert.ok(of(unread.doc, 'partial').some((f) => f.where === 'capture'))

  const noBase = workspace().check({ base: ['--base', 'no-such-ref'] })
  assert.equal(noBase.code, 1)
  assert.deepEqual(noBase.doc.findings.map((f) => [f.rule, f.where]), [['unreadable', 'git']])
})

const HEAD_FAULTS = {
  'answers pending too': `const d = JSON.parse(out); d.meta.title = null; d.meta.title_source = 'pending'; out = JSON.stringify(d)`,
  'answers no document': `out = 'not a document'`,
}
for (const [name, rewrite] of Object.entries(HEAD_FAULTS)) {
  test(`AN25: a pending title whose head ${name} refuses, and every other fact is still compared`, () => {
    const { w, id } = pendingTitle()
    w.commit({ 'a.txt': 'one\n' })
    const cli = path.join(w.home, 'cli.mjs')
    fs.writeFileSync(cli, `import { spawnSync } from 'node:child_process'
const argv = process.argv.slice(2), real = spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...argv], { maxBuffer: 2 ** 30 })
let out = real.stdout.toString()
if (argv.includes('--head')) { ${rewrite} }
process.stdout.write(out)
process.exitCode = real.status
`)
    const { code, doc } = w.check({ body: `Seen in ${id}.`, cli: ['--cli', cli] })
    assert.equal(code, 1)
    assert.ok(of(doc, 'partial').some((f) => f.where === 'capture'))
    assert.ok(of(doc, 'captured-facts').some((f) => f.where === 'body'))
  })
}

// ── AN30
const wireless = (o) => reply('/events', o, { is_llm: false })
const unnamed = { ...shapeResponse({ status: 200, headers: [['content-type', 'application/json'], ['content-encoding', 'gzip']], body: Buffer.from('not gzip') }), headers: {} }
const OPAQUE = {
  'a coding the reader does not know': () => kept({}, prompt('x'), 'snappy'),
  'bytes that do not decode': () => kept({}, prompt('x'), 'zstd'),
  'a kept reply whose coding was not recorded': () => reply(CHAT, unnamed),
  'a WebSocket message that did not decompress': () => wsCall([{ b64: 'AAAA', decode_error: 'no' }]),
  'a stream no wire claims': () => wireless(stored(events([{ x: 1 }]))),
  'a line that is not JSON': () => `{"ts":"${NOW_THEN}","cut`,
}
for (const [name, row] of Object.entries(OPAQUE)) {
  test(`AN30: ${name} is counted opaque and refuses; --accept-partial lets it through and moves the hash`, () => {
    const w = workspace()
    w.commit({ 'a.txt': 'nothing here\n' })
    const plain = line(NOW_THEN, 'nothing shared')
    capture(w, SEGMENT, [plain, row()])
    const held = w.check()
    assert.equal(held.code, 1)
    assert.deepEqual([...new Set(held.doc.findings.map((f) => `${f.rule} ${f.where}`))], ['partial capture'])
    assert.equal(held.doc.coverage.opaque_bytes, Buffer.byteLength(row()) + 1)
    assert.equal(held.doc.coverage.scanned_bytes, Buffer.byteLength(plain) + 1)
    const let_through = w.check({ args: ['--accept-partial'] })
    assert.equal(let_through.code, 0)
    assert.deepEqual(let_through.doc.findings, [])
    assert.deepEqual(let_through.doc.accepted, held.doc.findings)
    assert.notEqual(let_through.doc.hash, held.doc.hash)
  })
}

test('AN30: what the capture never held is not opaque', () => {
  const w = workspace()
  w.commit({ 'a.txt': 'nothing here\n' })
  capture(w, SEGMENT, [wireless({ status: 200, kind: 'sse' }), wireless({ status: 200, kind: 'ws', messages: [{ omitted_bytes: 9 }] }), JSON.stringify({ ...JSON.parse(wireless({ status: 200, kind: 'sse' })), body_retention: 'log' })])
  const { code, doc } = w.check()
  assert.equal(code, 0, JSON.stringify(doc.findings))
  assert.equal(doc.coverage.opaque_bytes, 0)
})

test('AN30: --accept-partial lets through no other rule, and an opaque record is still compared as far as it can be', () => {
  const w = workspace()
  const text = ascii(60, 1)
  w.commit({ 'a.txt': `${text}\n`, 'b.txt': `ghp_${MIXED}\n` })
  capture(w, SEGMENT, [JSON.stringify({ ...JSON.parse(OPAQUE['a coding the reader does not know']()), note: text }), OPAQUE['a line that is not JSON']()])
  const { code, doc } = w.check({ args: ['--accept-partial'] })
  assert.equal(code, 1)
  assert.deepEqual(named(doc, 'captured-text'), ['a.txt'])
  assert.deepEqual(named(doc, 'secrets'), ['b.txt'])
  assert.deepEqual([...new Set(doc.accepted.map((f) => f.rule))], ['partial'])
  assert.deepEqual(of(doc, 'partial'), [])
})

test('AN30: a half line at a segment\'s end is no record: it is not opaque, and its text is still compared', () => {
  const plain = line(NOW_THEN, 'nothing shared')
  const half = (text) => `{"ts":"${NOW_THEN}","note":"${text}`
  const w = workspace()
  w.commit({ 'a.txt': `${ascii(60, 1)}\n` })
  const segment = capture(w, SEGMENT, [plain])
  fs.appendFileSync(segment, half('cut short'))
  const { code, doc } = w.check()
  assert.equal(code, 0, JSON.stringify(doc.findings))
  assert.equal(doc.coverage.opaque_bytes, 0)
  assert.equal(doc.coverage.scanned_bytes, fs.statSync(segment).size)

  const shared = workspace()
  shared.commit({ 'a.txt': `${ascii(60, 1)}\n` })
  fs.appendFileSync(capture(shared, SEGMENT, [plain]), half(ascii(60, 1)))
  const refused = shared.check()
  assert.deepEqual(refused.doc.findings.map((f) => f.rule), ['captured-text'])
  assert.deepEqual(refused.doc.accepted, [])
})

// ── AN31
test('AN31: a capture all of it at or past --before refuses, and --accept-partial is what lets it out; an empty capture folder is no failure', () => {
  const w = workspace()
  w.commit({ 'a.txt': 'nothing here\n' })
  fs.mkdirSync(path.join(w.trocar, 'raw'), { recursive: true })
  assert.equal(w.check().code, 0, 'nothing to compare yet')
  capture(w, SEGMENT, [line(NOW_THEN, 'nothing shared')])
  const early = w.check({ before: '2026-10-01T00:00:00.000Z' })
  assert.equal(early.code, 1)
  assert.deepEqual(early.doc.findings.map((f) => [f.rule, f.where]), [['partial', 'capture']])
  assert.equal(early.doc.coverage.scanned_bytes + early.doc.coverage.opaque_bytes, 0)
  assert.equal(w.check({ before: '2026-10-01T00:00:00.000Z', args: ['--accept-partial'] }).code, 0)
})

test('AN31: a --before a week back that skips records refuses, however little it compared; a recent one does not', () => {
  const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString()
  const w = workspace()
  w.commit({ 'a.txt': `${ascii(60, 1)}\n` })
  const skipped = line(ago(1), ascii(60, 1))
  capture(w, SEGMENT, [line(ago(10), 'nothing shared'), skipped])
  const early = w.check({ before: ago(8) })
  assert.equal(early.code, 1)
  assert.deepEqual(early.doc.findings.map((f) => [f.rule, f.where]), [['partial', 'capture']])
  assert.equal(early.doc.coverage.after_bytes, Buffer.byteLength(skipped) + 1)
  assert.ok(early.doc.coverage.scanned_bytes < early.doc.coverage.total_bytes, 'skipped, and said so')
  assert.equal(w.check({ before: ago(8), args: ['--accept-partial'] }).code, 0)
  assert.equal(w.check({ before: ago(6) }).code, 0, 'within the week the time is taken at its word')

  const whole = workspace()
  whole.commit({ 'a.txt': 'nothing here\n' })
  capture(whole, SEGMENT, [line(ago(10), 'nothing shared')])
  assert.equal(whole.check({ before: ago(8) }).code, 0, 'nothing was skipped')
})

// ── AN29
test('AN29: what a shell would read as more than a word never reaches one', () => {
  const shelled = { file: 'trocar', lead: [], shell: true }
  assert.throws(() => callOf(shelled, ['query', 'session', '--id', 'a&b']))
  assert.deepEqual(callOf(shelled, ['query', 'session', '--id', 'a.b'])[1], ['query', 'session', '--id', 'a.b'])
  assert.deepEqual(callOf({ ...shelled, shell: false }, ['a&b'])[1], ['a&b'])
})

test('AN29: with no --cli the trocar on PATH answers both the query and the raw read, and with none there it is exit 2', { skip: process.platform === 'win32' }, () => {
  const w = workspace()
  w.commit({ 'a.txt': 'nothing here\n' })
  capture(w, SEGMENT, [line(NOW_THEN, 'nothing shared')])
  const bin = tmpDir('trocar-prc-path-'), mark = path.join(bin, 'called')
  const realGit = spawnSync('sh', ['-c', 'command -v git']).stdout.toString().trim()
  fs.symlinkSync(realGit, path.join(bin, 'git'))
  const env = { PATH: bin }
  const text = path.join(w.home, 'text')
  fs.writeFileSync(text, 'x')
  const bare = spawnSync(process.execPath, [SCRIPT, '--json', '--before', BEFORE, '--title', text, '--body', text, '--base', 'base'], { cwd: w.dir, env: { ...w.env, ...env } })
  assert.equal(bare.status, 2)
  assert.equal(bare.stdout.length, 0)

  const shim = path.join(bin, 'trocar')
  fs.writeFileSync(shim, `#!/bin/sh\necho "$1" >> "${mark}"\nexec "${process.execPath}" "${BIN}" "$@"\n`)
  fs.chmodSync(shim, 0o755)
  const { code, doc } = w.check({ cli: [], env })
  assert.equal(code, 0, JSON.stringify(doc.findings))
  const called = fs.readFileSync(mark, 'utf8').split('\n')
  assert.ok(called.includes('query') && called.includes('raw'), called.join(' '))
})
