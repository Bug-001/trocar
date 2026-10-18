// test/off/english.test.mjs — D58 (RFC 1.6 §1.1) for everything `asight off` prints: the typical outputs are English, ASCII, at most 80 columns,
// and carry no `undefined` / `null` / `NaN`, no section or decision number, no internal code name and no `<…>` left to fill in. The four cases are the
// ones the manual's §3.4 sample and §1.4 describe, and the same four are what a person looks at as a picture (scripts/cli-shot.mjs): things to undo,
// holders still connected, nothing installed, and the install record lost with no `--yes`. Setting ASIGHT_EN_OUT to a directory writes each case's text
// there, which is how the pictures are taken; nothing else here touches the machine the tests run on (every OS tool and the daemon are injected).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOffCli } from '../../src/off/main.mjs'
import { runOff } from '../../src/off/orchestrate.mjs'
import { formatOffReceipt } from '../../src/off/receipt.mjs'
import { fakeIo } from '../cli/fixtures/on-ctx.mjs'
import { installedHome } from './fixtures/off-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const CODE_NAMES = /desired-off|left-unparsable|left-unreadable|unknown-kind|json-key|owned-file|pem-block|config-entry|root-key|json-array-item|nothing_installed|dry_run|op\.lock/
const out = process.env.ASIGHT_EN_OUT || null

/** Every rule of §1.1 that can be read off a text, in one place. `home`: the sandbox HOME, whose path a receipt shortens to `~`. */
function readable(name, text, { home = null } = {}) {
  if (out) fs.writeFileSync(path.join(out, `${name}.txt`), text.endsWith('\n') ? text : `${text}\n`)
  const where = `${name}:\n${text}`
  assert.doesNotMatch(text, /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/, `${where}\n(no CJK)`)
  assert.doesNotMatch(text, /\b(undefined|null|NaN)\b/, `${where}\n(nothing unread printed as a value)`)
  assert.doesNotMatch(text, /§|\bD\d+|\bR\d+\b|\bP2-\d+/, `${where}\n(no section or decision number)`)
  assert.doesNotMatch(text, CODE_NAMES, `${where}\n(no internal code name)`)
  assert.doesNotMatch(text, /<[^<>\n]+>/, `${where}\n(no placeholder left to fill in)`)
  for (const line of text.split('\n')) {
    assert.ok(!/[^\x20-\x7e]/.test(line) || (home && line.includes(home)), `${where}\n(ASCII only: ${JSON.stringify(line)})`)
    const words = line.trim().split(' ')
    assert.ok(line.length <= 80 || words.length === 1 || (words.length === 2 && words[0] === 'node'), `${where}\n(80 columns, or one path or command of its own: ${JSON.stringify(line)})`)
  }
}

test('D58: off with things to undo, and off with programs still connected, read as §1.1 asks', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'], daemon: { relayed: { closing: 2, waiting: 1, cut: 0 }, exitOnOff: false } })
  fs.appendFileSync(path.join(s.home, '.claude', 'settings.json').replace(/settings\.json$/, 'settings.json'), '') // the file is the one `on` wrote; nothing is added
  const io = fakeIo()
  assert.equal(await runOffCli([], { io, home: s.home, env: s.sh.env, platform: 'linux', deps: s.offDeps({ getuid: () => 1000 }) }), 0, io.text())
  readable('off-undone', io.stdoutText(), { home: s.home })
  assert.match(io.stdoutText(), /^Capture is off for /)

  // the §3.4 sample itself: a harness still connected through asight, forwarded only, and the daemon draining
  const held = formatOffReceipt({
    ok: true, all: true, harnesses: ['claude-code', 'codex'], routing: { confirmed: true, how: 'daemon-reply' },
    changed: [{ harness: 'claude-code', path: '/h/.claude/settings.json', change: 'env.NODE_EXTRA_CA_CERTS removed', result: 'restored' }, { harness: 'codex', path: '/h/.codex/.env', change: "asight's block removed", result: 'reverted-not-identical' }],
    removed: [], skipped: [], relayed: { closing: 2, waiting: 0, cut: 0 }, daemon: { pid: 4012, state: 'draining', exits_after: 2 },
    holders: [{ harness: 'codex', pid: 5530, name: 'codex' }], problems: [], notes: [],
  }, { home: '/h' })
  readable('off-holders', held)
  assert.match(held, /^Cut them now: asight off --now$/m)
  assert.ok(held.trimEnd().endsWith('Certificates stay installed. To remove them: asight uninstall'))
})

test('D58: off on a machine asight is not on, and off with the install record lost and no --yes, read as §1.1 asks', async () => {
  const home = tmpDir('asight-en-pristine-')
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: { exec: () => ({ status: 0, stdout: '', stderr: '' }), platform: 'linux', procs: async () => [], sleep: async () => {} } })
  assert.equal(exit, 0)
  readable('off-nothing', formatOffReceipt(receipt, { home }), { home })

  // §1.4: the record is gone, there is no terminal and no --yes — the routing comes off, the files are untouched, the plan is listed, exit 1
  const s = await installedHome({ names: ['codex'] })
  fs.rmSync(path.join(s.dir, 'install-manifest.json'))
  const before = fs.readFileSync(path.join(s.home, '.codex', '.env'))
  const io = fakeIo({ tty: false })
  assert.equal(await runOffCli([], { io, home: s.home, env: s.sh.env, platform: 'linux', deps: s.offDeps({ getuid: () => 1000 }) }), 1, io.text())
  assert.deepEqual(fs.readFileSync(path.join(s.home, '.codex', '.env')), before, 'not a byte of the user\'s file moved')
  readable('off-no-record', io.stdoutText(), { home: s.home })
  assert.match(io.stdoutText(), /Found by asight's own marks and not undone yet:/)
  assert.match(io.stdoutText(), /Undo it by the marks asight left in it: asight off --yes/) // one file: the sentence counts with it
})
