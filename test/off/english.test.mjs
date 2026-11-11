// test/off/english.test.mjs — D58 (RFC 1.6 §1.1) for everything `trocar off` prints: the typical outputs are English, ASCII, at most 80 columns,
// and carry no `undefined` / `null` / `NaN`, no section or decision number, no internal code name and no `<…>` left to fill in. The four cases are the
// ones the manual's §3.4 sample and §1.4 describe, and the same four are what a person looks at as a picture (scripts/cli-shot.mjs): things to undo,
// holders still connected, nothing installed, and the install record lost with no `--yes`. Setting TROCAR_EN_OUT to a directory writes each case's text
// there, which is how the pictures are taken; nothing else here touches the machine the tests run on (every OS tool and the daemon are injected).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOffCli } from '../../src/off/main.mjs'
import { runOff } from '../../src/off/orchestrate.mjs'
import { formatOffReceipt } from '../../src/off/receipt.mjs'
import { fakeIo } from '../cli/fixtures/on-ctx.mjs'
import { installedHome, onSwitch } from './fixtures/off-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { POSIX_WORLD } from '../helpers/platform-shape.mjs'

const CODE_NAMES = /desired-off|left-unparsable|left-unreadable|unknown-kind|json-key|owned-file|pem-block|config-entry|root-key|json-array-item|nothing_installed|dry_run|op\.lock/
const out = process.env.TROCAR_EN_OUT || null

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

test('D58: off with things to undo, and off with programs still connected, read as §1.1 asks', { skip: POSIX_WORLD }, async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'], daemon: { relayed: { closing: 2, waiting: 1, cut: 0 }, exitOnOff: false } })
  fs.appendFileSync(path.join(s.home, '.claude', 'settings.json').replace(/settings\.json$/, 'settings.json'), '') // the file is the one `on` wrote; nothing is added
  const io = fakeIo()
  assert.equal(await runOffCli([], { io, home: s.home, env: s.sh.env, platform: 'linux', deps: s.offDeps({ getuid: () => 1000 }) }), 0, io.text())
  readable('off-undone', io.stdoutText(), { home: s.home })

  // the §3.4 sample itself: a harness still connected through trocar, forwarded only, and the daemon running
  const held = formatOffReceipt({
    ok: true, all: true, harnesses: ['claude-code', 'codex'], routing: { confirmed: true, how: 'daemon-reply' },
    changed: [{ harness: 'claude-code', path: '/h/.claude/settings.json', change: 'env.NODE_EXTRA_CA_CERTS removed', result: 'restored' }, { harness: 'codex', path: '/h/.codex/.env', change: "trocar's block removed", result: 'reverted-not-identical' }],
    removed: [], skipped: [], relayed: { closing: 2, waiting: 0, cut: 0 }, daemon: { pid: 4012, state: 'running' },
    holders: [{ harness: 'codex', pid: 5530, name: 'codex' }], problems: [], notes: [],
  }, { home: '/h' })
  readable('off-holders', held)
  assert.match(held, /^Cut them now: trocar off --now$/m)
  assert.ok(held.trimEnd().endsWith('Certificates stay installed. To remove them: trocar uninstall'))
})

test('D58: off on a machine trocar is not on, and off with the install record lost and no --yes, read as §1.1 asks', async () => {
  const home = tmpDir('trocar-en-pristine-')
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: { exec: () => ({ status: 0, stdout: '', stderr: '' }), platform: 'linux', procs: async () => [], sleep: async () => {} } })
  assert.equal(exit, 0)
  readable('off-nothing', formatOffReceipt(receipt, { home }), { home })

  // §1.4: the record is gone, there is no terminal and no --yes — the routing comes off, the files are untouched, the plan is listed, exit 1
  const s = await installedHome({ names: ['kimi-code'] })
  fs.rmSync(path.join(s.dir, 'install-manifest.json'))
  const sw = onSwitch(s, 'kimi-code') // one file left to undo: on's switch file (the Kimi shim and rc line are install's)
  const rc = s.sh.files['kimi-code'][0]
  const before = [rc, sw].map((f) => fs.readFileSync(f))
  const io = fakeIo({ tty: false })
  assert.equal(await runOffCli([], { io, home: s.home, env: s.sh.env, platform: 'linux', deps: s.offDeps({ getuid: () => 1000 }) }), 1, io.text())
  assert.deepEqual([rc, sw].map((f) => fs.readFileSync(f)), before, 'not a byte moved')
  readable('off-no-record', io.stdoutText(), { home: s.home })
  assert.match(io.stdoutText(), /Found by trocar's own marks and not undone yet:/)
  assert.match(io.stdoutText(), /Undo it by the marks trocar left in it: trocar off --yes/) // one file: the sentence counts with it
})

// D62 ⑥: a nameless `off` switches capture off and the daemon stays, in both modes. With a program still connected, ONE door stays open, passing
// its traffic on and recording nothing of it (P12), so the receipt must not also say "with no door open", nor that trocar exits.
test('D62 ⑥: with a holder the receipt never claims "no door open" nor that trocar exits; a --dry-run reads as §1.1 asks', () => {
  const base = {
    ok: true, all: true, harnesses: ['codex'], routing: { confirmed: true, how: 'daemon-reply' },
    changed: [], removed: [], skipped: [], problems: [], notes: [], relayed: { closing: 0, waiting: 1, cut: 0 },
  }
  const holder = [{ harness: 'codex', pid: 5530, name: 'codex' }]

  const held = formatOffReceipt({ ...base, daemon: { pid: 4012, state: 'running' }, holders: holder })
  readable('off-proxy-holder', held)
  assert.doesNotMatch(held, /no door open/, `a door IS open for the holder below: ${held}`)
  assert.doesNotMatch(held, /trocar exits|exits when/, `in proxy mode the daemon never exits: ${held}`)
  assert.match(held.replace(/\s+/g, ' '), /\b4012\b[^.]*\bkeeps running\b[^.]*\bdoor\b/, 'D62 ⑥: the daemon stays, a door open for the holder')
  assert.match(held, /^That door closes when it exits; the daemon keeps running\.$/m)

  // --dry-run: no daemon was asked anything, so there is no pid
  const dry = formatOffReceipt({ ...base, dry_run: true, daemon: { pid: null, state: 'running' }, holders: [] })
  readable('off-proxy-dry', dry)
})

// 1.6 §1.1⑥: the list a marker-only off asks about — each file an item at column 2 with what would be done to it on the same item, folded past
// the command column, never a line at column 4 that is not a command, and HOME as ~
test('§1.1⑥ the marker-only listing: one item a file, its words with it, nothing at the command column, inside 80 columns', async () => {
  const { markerListing } = await import('../../src/off/orchestrate.mjs')
  const home = '/home/alice'
  for (const depth of [1, 5]) {
    const plan = ['block', 'json-value', 'owned-file'].map((how, i) => ({ harness: ['codex', 'claude-code', 'opencode'][i], how, path: `${home}/${'deep/'.repeat(depth)}file-${i}` }))
    const out = markerListing(plan, home).split('\n')
    assert.ok(out.every((l) => l.length <= 80 || !/\s/.test(l.trim())), `80 columns, a path whole\n${out.join('\n')}`)
    assert.ok(!out.some((l) => /^ {4}\S/.test(l)), `no line at the command column\n${out.join('\n')}`)
    assert.ok(out.every((l) => !l.includes(home)), out.join('\n'))
    for (const p of plan) assert.ok(out.some((l) => /^ {2}\S/.test(l) && l.includes(p.harness)), `${p.harness} is an item at column 2\n${out.join('\n')}`)
    const starts = plan.map((p) => out.find((l) => l.startsWith(`  ${p.harness} `)).indexOf('~/'))
    assert.equal(new Set(starts).size, 1, `§1.1②: every path starts in one value column\n${out.join('\n')}`)
  }
})
