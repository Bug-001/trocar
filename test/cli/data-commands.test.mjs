// test/cli/data-commands.test.mjs — the three data commands (RFC 1.6 §4.1, §4.2, §5.1; V79 V80 V81 V82 V83): `query` lists its names and
// prints a query's document, `status` / `doctor` with --json ARE the documents `asight query status` / `doctor` print, `classes` shows and edits
// the class table, and `raw` prints a segment's bytes as they were captured. Nothing here reaches the machine the tests run on: a temp HOME, and
// for `status` / `doctor` the injected deps of the dispatch fixture (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runCli } from '../../src/cli/main.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { RECEIPT_KEYS } from '../../src/cli/schema.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { assertEnglish } from '../helpers/english.mjs'
import { envLine, snapshot } from '../query/raw-home.mjs'
import { sandbox, fakeIo } from './fixtures/dispatch-ctx.mjs'
import { usageLine, commandNamed } from '../../src/cli/commands.mjs'

/** Everything a command wrote but the index it may rebuild (~/.asight/index/ is the deletable projection, §4.1). */
const stable = (dir) => Object.fromEntries(Object.entries(snapshot(dir)).filter(([rel]) => !rel.startsWith('index/')))
/** What was said, without the usage line: that line is help's own text and carries its `<placeholders>` on purpose. */
const said = (text, name) => text.split('\n').filter((l) => !usageLine(commandNamed(name)).startsWith(l.trim()) || l.trim() === '').join('\n')

const SEG = '20261018T100000Z'
const SEALED = '20261018T110000Z'

/** A HOME with two segments in ~/.asight/raw: one being written, one sealed. → { home, lines } (the bytes as captured, per segment). */
async function dataHome() {
  const home = tmpDir('asight-data-')
  const raw = path.join(home, '.asight', 'raw')
  fs.mkdirSync(raw, { recursive: true, mode: 0o700 })
  const lines = {
    [SEG]: [envLine({}), envLine({ ts: '2026-10-18T10:00:01.000Z', class: 'telemetry', is_llm: false })],
    [SEALED]: [envLine({ ts: '2026-10-18T11:00:00.000Z', id: 'req_00002' })],
  }
  for (const [seg, ls] of Object.entries(lines)) fs.writeFileSync(path.join(raw, `${seg}.ndjson`), ls.join('\n') + '\n', { mode: 0o600 })
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  await sealSegment(path.join(raw, `${SEALED}.ndjson`), { lockFile: path.join(home, '.asight', 'collector', 'lock'), journal: null })
  return { home, lines }
}

const run = async (argv, home, over = {}) => {
  const io = fakeIo()
  const exit = await runCli(argv, { io, uid: 1000, platform: 'linux', home, ...over })
  return { exit, io, out: io.stdoutText(), err: io.stderrText() }
}

test('V80: `asight status --json` and `asight doctor --json` print exactly the documents `asight query status` / `query doctor` print', async () => {
  const s = sandbox()
  for (const name of ['status', 'doctor']) {
    const c = s.ctx()
    const exit = await runCli([name, '--json'], c)
    const printed = JSON.parse(c.io.stdoutText())
    const asked = await runQuery(name, {}, { home: path.join(s.home, '.asight'), userHome: s.home, env: c.env, platform: c.platform, deps: c.deps })
    assert.deepEqual(printed, asked, `${name}: the command and the query are one document`)
    assert.ok([0, 1, 3].includes(exit), `${name}: exit ${exit}`)
    // and the same document comes out of `asight query <name>` on the command line
    const viaQuery = await runCli(['query', name], s.ctx())
    assert.ok([0, 1].includes(viaQuery), `query ${name}: exit ${viaQuery}`)
  }
})

test('V81: `asight query` lists every name with its parameters, a query prints its document, an unknown name or parameter is exit 2', async () => {
  const { home } = await dataHome()
  const list = await run(['query'], home)
  assert.equal(list.exit, 0)
  assertEnglish(list.out, 'asight query')
  for (const name of ['status', 'doctor', 'sessions', 'session', 'calls', 'block', 'classes', 'segments', 'pricing']) {
    assert.match(list.out, new RegExp(`^${name} `, 'm'), `${name} is listed`)
  }
  assert.match(list.out, /^segments\s+--since --until$/m, 'with its parameters')

  const doc = await run(['query', 'segments'], home)
  assert.equal(doc.exit, 0)
  assert.deepEqual(JSON.parse(doc.out).segments.map((x) => x.segment).sort(), [SEG, SEALED])
  assert.equal(doc.err, '', 'the document is on stdout and nothing is on stderr')

  for (const argv of [['query', 'nope'], ['query', 'segments', '--frob', 'x'], ['query', 'segments', 'extra']]) {
    const bad = await run(argv, home)
    assert.deepEqual([bad.exit, bad.out], [2, ''], argv.join(' '))
    assert.ok(bad.err.trimEnd().split('\n').length <= 2, `${argv.join(' ')}: one message (it may fold once at 80 columns)`)
    assertEnglish(bad.err, argv.join(' '))
  }
  // --json: the error is the JSON error document on stdout, nothing on stderr (§1.2)
  const asJson = await run(['query', 'nope', '--json'], home)
  assert.deepEqual([asJson.exit, asJson.err], [2, ''])
  assert.deepEqual([JSON.parse(asJson.out).ok, JSON.parse(asJson.out).error.code], [false, 'usage'])
})

test('V82: `asight raw` prints the records of a plain and of a sealed segment byte for byte; an unknown segment or record number is exit 1', async () => {
  const { home, lines } = await dataHome()
  for (const seg of [SEG, SEALED]) {
    const all = await run(['raw', seg], home)
    assert.deepEqual([all.exit, all.err], [0, ''], seg)
    assert.equal(all.out, lines[seg].join('\n') + '\n', `${seg}: the bytes as they were captured`)
  }
  const one = await run(['raw', `${SEG}:2`], home)
  assert.equal(one.out, lines[SEG][1] + '\n', 'one record by its number')
  const span = await run(['raw', `${SEG}:1-2`], home)
  assert.equal(span.out, lines[SEG].join('\n') + '\n', 'both ends included')

  for (const argv of [['raw', 'nope'], ['raw', `${SEG}:9`], ['raw', `${SEG}:9-11`]]) {
    const bad = await run(argv, home)
    assert.deepEqual([bad.exit, bad.out], [1, ''], argv.join(' '))
    assertEnglish(said(bad.err, 'raw'), argv.join(' '))
  }
  for (const argv of [['raw'], ['raw', SEG, 'more'], ['raw', `${SEG}:3-1`]]) {
    const bad = await run(argv, home)
    assert.deepEqual([bad.exit, bad.out], [2, ''], argv.join(' '))
    assertEnglish(said(bad.err, 'raw'), argv.join(' '))
  }
})

test('V83: `asight classes` shows the table and one class; an edit prints the receipt and the file changes', async () => {
  const { home } = await dataHome()
  const file = path.join(home, '.asight', 'classes.json')
  const table = await run(['classes'], home)
  assert.equal(table.exit, 0)
  assertEnglish(table.out, 'asight classes')
  assert.match(table.out, /^CLASS\s+KEEP\s+MATCHES\s+24 H\s+7 D\s+ALL$/m)
  assert.match(table.out, /^llm\s+full\s+model API calls, \d+ rules/m)
  assert.ok(!fs.existsSync(file), 'showing wrote no table of yours')
  assert.deepEqual(JSON.parse((await run(['classes', '--json'], home)).out), await runQuery('classes', {}, { home: path.join(home, '.asight') }), '--json is the query document')

  const one = await run(['classes', 'llm'], home)
  assert.deepEqual([one.exit, one.err], [0, ''])
  assertEnglish(one.out, 'asight classes llm')
  assert.match(one.out, /^llm: keep full \(as asight ships it\)$/m)  // no table of yours yet
  assert.match(one.out, /^ {2}RULE\s+HOST\s+PATH\s+HARNESS$/m)
  assert.match(one.out, /^ {2}1 /m)

  const set = await run(['classes', 'set', 'telemetry', 'log'], home)
  assert.deepEqual([set.exit, set.err], [0, ''])
  assertEnglish(set.out, 'asight classes set')
  assert.match(set.out, /^telemetry: keep full, \d+ rules -> keep log, \d+ rules$/m)
  assert.match(set.out, /^Wrote ~\/\.asight\/classes\.json$/m)
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(written.classes.find((c) => c.class === 'telemetry').keep, 'log', 'the file holds the new level')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.match((await run(['classes', 'telemetry'], home)).out, /^telemetry: keep log \(yours, changed /m) // your own table now

  const add = await run(['classes', 'add', 'catalog', 'models\\.opencode\\.ai', '/api\\.json', '--harness', 'opencode'], home)
  assert.deepEqual([add.exit, add.err], [0, ''])
  assert.match(add.out, /^catalog: not in the table -> keep full, 1 rule$/m)
  assert.match((await run(['classes', 'catalog'], home)).out, /^ {2}1 {5}models\\\.opencode\\\.ai {2}\/api\\\.json {2}opencode$/m)
  assert.equal((await run(['classes', 'rm', 'catalog', '1'], home)).exit, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).classes.find((c) => c.class === 'catalog').rules, [])

  const reset = await run(['classes', 'reset'], home)
  assert.deepEqual([reset.exit, reset.err], [0, ''])
  assert.match(reset.out, /^classes: the table is as asight ships it again$/m)
  assert.ok(!fs.existsSync(file), 'reset took your table away')
  // --json of a change is a receipt (R5)
  const asJson = await run(['classes', 'set', 'telemetry', 'log', '--json'], home)
  assert.deepEqual([asJson.exit, asJson.err], [0, ''])
  const receipt = JSON.parse(asJson.out)
  assert.deepEqual(RECEIPT_KEYS.filter((k) => !(k in receipt)), [], 'a receipt carries at least the R5 keys')
  assert.deepEqual([receipt.command, receipt.ok, receipt.class, receipt.before.keep, receipt.after.keep], ['classes', true, 'telemetry', 'full', 'log'])
  assert.deepEqual(receipt.changed.map((c) => c.change), ['written', 'appended'])
})

test('V83: a class, a regex or a rule number that is not there is exit 2, one line, and nothing is written', async () => {
  const { home } = await dataHome()
  const before = stable(path.join(home, '.asight'))
  for (const argv of [['classes', 'set', 'nope', 'log'], ['classes', 'set', 'llm', 'some'], ['classes', 'set', 'Llm', 'log'],
    ['classes', 'add', 'models', '('], ['classes', 'add', 'models', 'x', '('], ['classes', 'add', 'other', 'x'],
    ['classes', 'rm', 'llm', '99'], ['classes', 'rm', 'llm', 'first'], ['classes', 'rm', 'nope'],
    ['classes', 'nope'], ['classes', 'llm', 'telemetry'], ['classes', 'set', 'llm'], ['classes', 'reset', 'llm'],
    ['classes', 'add', 'models', 'x', '--harness', 'clade']]) {
    const bad = await run(argv, home)
    assert.deepEqual([bad.exit, bad.out], [2, ''], argv.join(' '))
    assertEnglish(said(bad.err, 'classes'), argv.join(' '))
    assert.ok(bad.err.trim().length > 0, `${argv.join(' ')}: it says what is wrong`)
    assert.deepEqual(stable(path.join(home, '.asight')), before, `${argv.join(' ')} wrote nothing`)
  }
})

test('V79: query, classes shown and raw write nothing but the index they may rebuild', async () => {
  const { home } = await dataHome()
  const asight = path.join(home, '.asight')
  const before = snapshot(asight)
  for (const argv of [['query', 'segments'], ['query', 'classes'], ['query', 'sessions'], ['classes'], ['classes', 'llm'], ['raw', SEG], ['raw', SEALED]]) {
    assert.ok([0, 1].includes((await run(argv, home)).exit), argv.join(' '))
  }
  const after = snapshot(asight)
  for (const [rel, bytes] of Object.entries(after)) {
    if (rel.startsWith('index/')) continue // ~/.asight/index/ is the deletable projection (§4.1)
    assert.equal(bytes, before[rel], `${rel} changed`)
  }
  for (const rel of Object.keys(before)) assert.ok(rel in after, `${rel} is gone`)
  assert.ok(Object.keys(after).some((rel) => rel.startsWith('index/')), 'the index is where the index goes')
})
