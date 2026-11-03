// test/cli/fold-commands.test.mjs — 1.6 §1.1⑥ / §3.5: a command to copy sits on its own line, and a folded line of prose never lands on a command's
// indent, in every receipt (on, off, uninstall; install prints through the same fit) and in `status --failures`. Output alone cannot tell a fold from
// an item, so the check compares two runs of one formatter: the same fixture with short values and with long ones (routes, paths, reasons past 80
// columns). Folding adds lines; none of the added lines may sit at an indent a command uses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatOnReceipt, formatUninstallReceipt } from '../../src/cli/receipt.mjs'
import { formatOffReceipt } from '../../src/off/receipt.mjs'
import { failuresBlock } from '../../src/cli/status-text.mjs'

const HOME = '/home/al'
const NOW = Date.parse('2026-11-04T00:00:00Z')
const words = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ')
/** Short values fit one line; long ones fold (several words) or move a whole word to its own line (one long path). */
const vals = (long) => ({
  reason: long ? words(30, 'because') : 'because',
  path: long ? `${HOME}/${'deep/'.repeat(14)}file.json` : `${HOME}/f.json`,
  host: long ? `proxy.${'corp.'.repeat(10)}example.com:8080` : 'proxy.corp:8080',
})
const indent = (l) => l.length - l.trimStart().length

const FORMATTERS = {
  on: (v) => [formatOnReceipt({
    changed: [], created: [], restart: [], notes: [], skipped: [{ what: v.path, reason: v.reason }],
    adopted: { codex: { chain: `codex -> [ebpf] trocar -> [CONNECT passed on as it is] ${v.host} -> internet`, proxy: `http://***@${v.host}`, source: [{ kind: 'file', where: v.path, key: 'proxy' }] } },
    blocked: [{ command: 'trocar install' }],
  }, { home: HOME }), ['trocar install']],
  off: (v) => [formatOffReceipt({
    changed: [], removed: [v.path], skipped: [{ what: `${HOME}/other.json`, reason: v.reason }],
    still_trusting: [{ what: 'root', reason: v.reason, command: 'security delete-certificate -c trocar' }], pending: [{ harness: 'codex', path: v.path }],
  }, { home: HOME }), ['security delete-certificate -c trocar']],
  uninstall: (v) => [formatUninstallReceipt({
    ok: false, changed: [{ path: v.path, change: v.reason }], removed: [], left: [{ path: v.path, reason: v.reason, command: 'trocar off' }],
  }, { home: HOME, platform: 'linux', tense: 'past' }), ['trocar off']],
  failures: (v) => [failuresBlock({
    groups: [{ level: 'problem', count: 2, last_ts: new Date(NOW - 60e3).toISOString(), where: 'daemon', code: 'helper-down', harness: 'codex', reason: `${v.reason} run \`sudo trocar setup-helper\` and ${v.reason} then \`sudo trocar setup-helper --remove\` ${v.reason}` }],
  }, { collector: { expected: {} } }, { now: NOW }).join('\n'), ['sudo trocar setup-helper', 'sudo trocar setup-helper --remove']],
}

for (const [name, render] of Object.entries(FORMATTERS)) {
  test(`1.6 §1.1⑥ ${name}: lengthening the values folds prose, and no folded line lands on an indent a command uses`, () => {
    const [short, cmds] = render(vals(false)), [long] = render(vals(true))
    const lines = (t) => t.split('\n').filter((l) => l.trim())
    const isCommand = (l) => cmds.includes(l.trim())
    const commandIndents = new Set(lines(long).filter(isCommand).map(indent))
    assert.equal(lines(long).filter(isCommand).length, cmds.length, `each command whole on a line of its own\n${long}`)
    assert.ok(lines(long).length > lines(short).length, `the long values fold\n${long}`)
    const atCommandIndent = (t) => lines(t).filter((l) => !isCommand(l) && commandIndents.has(indent(l))).length
    assert.equal(atCommandIndent(long), atCommandIndent(short), `a fold never sits at a command's indent ${[...commandIndents]}\n--- short\n${short}\n--- long\n${long}`)
  })
}
