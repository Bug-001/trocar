// test/cli/not-implemented.test.mjs — the three commands the data-format branch (D59/D60) still owes (query, classes, raw): until they are
// written they say so in one line a person can read, and with --json (query, classes; raw prints bytes and has no --json) in exactly one error document on stdout with nothing on stderr (RFC 1.6 §1.2, §1.3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { runCli } from '../../src/cli/main.mjs'
import { WIDTH } from '../../src/cli/text.mjs'
import { fakeIo } from './fixtures/dispatch-ctx.mjs'

const NAMES = ['query', 'classes', 'raw']
const run = async (argv) => { const io = fakeIo(); const exit = await runCli(argv, { io, uid: 1000, platform: 'linux' }); return { exit, io } }

test('query / classes / raw say they are not implemented yet in one line of at most 80 columns, on stderr, exit 1', async () => {
  for (const name of NAMES) {
    const { exit, io } = await run([name])
    assert.equal(exit, 1, name)
    assert.equal(io.stdoutText(), '', `${name}: nothing on stdout`)
    const lines = io.stderrText().trimEnd().split('\n')
    assert.deepEqual(lines, [`asight ${name}: not implemented yet. It arrives with the data-format update.`], name)
    assert.ok(lines[0].length <= WIDTH, `${name}: ${lines[0].length} columns`)
  }
})

test('--json: one error document on stdout, code not-implemented, nothing on stderr, exit 1', async () => {
  for (const name of ['query', 'classes']) {
    const { exit, io } = await run([name, '--json'])
    assert.equal(exit, 1, name)
    assert.equal(io.stderrText(), '', `${name}: nothing on stderr`)
    const doc = JSON.parse(io.stdoutText())
    assert.equal(io.stdoutText().trim(), JSON.stringify(doc), `${name}: that one document and nothing else`)
    assert.deepEqual([doc.command, doc.ok, doc.error.code], [name, false, 'not-implemented'])
    assert.match(doc.error.message, /not implemented yet/)
  }
})
