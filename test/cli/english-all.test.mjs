// test/cli/english-all.test.mjs — V73, the ONE readability check over every command, so no command's text has to be remembered one at a time
// (spec 1.6 §1.1 / D58: English, ASCII, 80 columns, nothing a reader cannot act on; §1.2: `--json` writes the document to stdout and NOTHING to
// stderr). A Windows test machine found a Chinese note in the `on` receipt (P6, 2026-10-18) and a macOS one found `on --json` writing 496 B of human text to
// stderr — both reachable from a sandbox HOME, so both belong here and not in a test-machine run.
// Nothing here reaches the machine: the sandbox's HOME is a tmpDir, every OS tool, process table, socket and daemon is a stand-in (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { sandbox } from './fixtures/dispatch-ctx.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { assertEnglish } from '../helpers/english.mjs'
import { appendEvent } from '../../src/collector/core/events.mjs'

// every command that prints to a person and runs without changing the machine, plus the four state-changing ones as a plan (R6: the plan is the
// receipt of the real run, in the future tense, so it carries the same words)
const SCREENS = [
  ['help'], ['status'], ['status', '--failures'], ['doctor'], ['query'], ['classes'], ['raw', 'x'],
  ['install', '--dry-run'], ['on', '--dry-run'], ['off', '--dry-run'], ['uninstall', '--dry-run'],
]

for (const argv of SCREENS) {
  test(`V73 · trocar ${argv.join(' ')}: the text a person reads is English, inside 80 columns, with nothing unreadable in it`, async () => {
    const s = await sandbox()
    const { io } = await s.run(argv)
    const text = io.text()
    assert.ok(text.trim() !== '', `trocar ${argv.join(' ')} printed nothing`)
    assertEnglish(text, `trocar ${argv.join(' ')}`, { placeholders: argv[0] === 'help' }) // help's `<name>` is what the reader types
  })
  test(`§1.2 · trocar ${argv.join(' ')} --json: the document goes to stdout, stderr stays empty`, async () => {
    const s = await sandbox()
    const { io } = await s.run([...argv, '--json'])
    assert.equal(io.stderrText(), '', `trocar ${argv.join(' ')} --json wrote to stderr: ${JSON.stringify(io.stderrText())}`)
    // `raw` has no --json (it prints captured bytes, 1.6 §4.3) and a bare `query` prints the table of query names (§4.1): neither is a document
    if (argv[0] === 'raw' || argv[0] === 'query') return
    const out = io.stdoutText().trim()
    assert.doesNotThrow(() => JSON.parse(out), `trocar ${argv.join(' ')} --json: stdout is not one document:\n${out}`)
  })
}

// the descriptors are data a harness author writes (4.11): every sentence in one can end up in a receipt, a status line or a note, so the whole
// descriptor is held to the same rule — the alternative is finding the next one on a test machine
test('V73 · every string in every harness descriptor is English and ASCII (a receipt, a note or a status line may print any of them)', async () => {
  const descriptors = await loadHarnesses()
  for (const d of descriptors) {
    const walk = (v, at) => {
      if (typeof v === 'string') assertEnglish(v, `${at} of the ${d.id || d.harness || d.name} descriptor`, { width: false }) // a renderer wraps these
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k)
    }
    walk(d, '')
  }
})

// the problem rows and the Expected section carry the records' own reasons, cut to a head: with long reasons and by-design rows on disk the same
// rule holds (the mac and win VM terminals 2026-10-21 showed rows of 200 columns broken mid-word and a non-ASCII cut mark)
test('V73 · trocar status --failures over long failure reasons and by-design rows: English, ASCII, inside 80 columns', async () => {
  const s = await sandbox()
  const long = 'the owner of 127.0.0.1:50211 could not be read (owner unreadable); the app keeps its own way until it fetches the PAC again, and so on '.repeat(3)
  const at = new Date().toISOString()
  appendEvent(s.dir, { ts: at, event: 'failure', where: 'ingress', code: 'pac-owner-unread', peer: '127.0.0.1:50211', reason: long })
  appendEvent(s.dir, { ts: at, event: 'failure', where: 'engine', code: 'no-such-code-of-trocar', reason: long })
  for (const reason of ['not-an-agent', 'group-off', 'outside-host-set']) appendEvent(s.dir, { ts: at, flow_id: reason, pid: 4242, host: 'api.example', decision: 'splice', not_captured: 'untracked', reason })
  const { io } = await s.run(['status', '--failures'])
  assertEnglish(io.text(), 'trocar status --failures')
})
