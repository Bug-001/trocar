// voice.test.mjs — 1.6 §1.1 ④ (D58 ⑦, V128): the default text says no word of the UNSAID table, and every fact it leaves out is in --details.
// It asserts those two invariants and the shared helpers' arithmetic, never the wording or the layout of a whole screen (those are looked at).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { andList, countsBy } from '../../src/cli/text.mjs'
import { unsaidIn } from '../../src/cli/words.mjs'
import { formatUninstallReceipt, formatUninstallText } from '../../src/cli/receipt.mjs'
import { newReceipt } from '../../src/off/schema.mjs'

const HOMES = { darwin: '/Users/alice', linux: '/home/alice', win32: 'C:\\Users\\alice' }
const P = (platform) => (platform === 'win32' ? path.win32 : path.posix)

test('andList and countsBy say a list as a sentence, a count by key in first-seen order', () => {
  assert.deepEqual([andList([]), andList(['a']), andList(['a', 'b']), andList(['a', 'b', 'c'])], ['', 'a', 'a and b', 'a, b and c'])
  const procs = [{ h: 'codex' }, { h: 'pi' }, { h: 'codex' }]
  assert.equal(countsBy(procs, (p) => p.h), '2 codex and 1 pi processes')
  assert.equal(countsBy([{ h: 'pi' }], (p) => p.h), '1 pi process')
})

test('unsaidIn finds the unsaid words outside a command line, whole words only', () => {
  assert.deepEqual(unsaidIn('Capture is off.\nThe daemon keeps running.\n    kill 5530\nthe door is shut'), ['The daemon keeps running.', 'the door is shut'])
  assert.deepEqual(unsaidIn('Capturing 4 of 5 agents.\nrapid entryway'), [], 'a word inside another word is not that word')
})

// an uninstall with something of every kind the receipt can hold: files of the user's, trocar's own, a key, backups, kept data, a stopped
// service, a sealed segment and a file the user changed after trocar did
const receipt = (over = {}, platform = 'darwin') => {
  const home = HOMES[platform], j = (...x) => P(platform).join(home, ...x), dot = j('.trocar'), col = j('.trocar', 'collector')
  return {
  ...newReceipt('uninstall'), ok: true, purge_data: false,
  changed: [{ path: j('.claude', 'settings.json'), change: 'env.HTTPS_PROXY taken out', harness: 'claude-code' },
    { path: j('.config', 'app', 'lib', 'a.json'), change: 'proxy taken out' }, { path: j('.config', 'app', 'lib', 'b.json'), change: 'id taken out' }],
  removed: [j('.config', 'opencode', 'plugins', 'trocar.js'), P(platform).join(col, 'state.json'), P(platform).join(dot, 'bin', 'trocar-off'), 'keychain:3F9A0C'],
  dropped_backups: [P(platform).join(dot, 'backup', 'aa-1'), P(platform).join(dot, 'backup', 'bb-2')],
  kept: [{ what: 'your captured records', path: P(platform).join(dot, 'raw'), bytes: 2_300_000_000 }, { what: "trocar's record of what it did and what failed", path: P(platform).join(col, 'flows'), bytes: 13_400_000 }],
  daemon: { state: 'stopped', pid: 4242 },
  sealed: [{ segment: '20261109T010000Z', bytes: 80_900, sealed_bytes: 26_300 }],
  non_identical: [{ path: j('.claude', 'settings.json'), backup: P(platform).join(dot, 'backup', 'aa-1') }],
  left: [], problems: [], notes: [], ...over,
  }
}

test('uninstall: the default plan and receipt say no unsaid word, and --details holds every path the receipt carries', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const home = HOMES[platform], r = receipt({}, platform)
    const plan = formatUninstallText({ ...r, dry_run: true }, { home, platform, tense: 'future', asking: true })
    const done = formatUninstallText(r, { home, platform })
    for (const [what, text] of [['plan', plan], ['receipt', done]]) assert.deepEqual(unsaidIn(text), [], `${platform} ${what}:\n${text}`)
    const details = formatUninstallReceipt(r, { home, platform })
    const paths = [...r.changed.map((c) => c.path), ...r.removed.filter((p) => p.startsWith(home)), ...r.kept.map((k) => k.path), ...r.non_identical.map((n) => n.backup)]
    for (const p of paths) assert.ok(details.includes(`~${p.slice(home.length)}`), `${platform}: --details names ${p}`) // HOME as ~ (§1.1⑤)
    assert.match(details, /4242/, 'the pid is a --details fact')
  }
})

test('uninstall (§1.4): the default plan names every file of yours outside ~/.trocar, and never says nothing was changed before the question', () => {
  const home = HOMES.darwin
  const plan = formatUninstallText(receipt({ dry_run: true }), { home, platform: 'darwin', tense: 'future', asking: true })
  for (const p of ['.claude/settings.json', '.config/opencode/plugins/trocar.js']) assert.ok(plan.includes(`~/${p}`), p)
  assert.ok(plan.includes('~/.config/app/lib') && !plan.includes('a.json'), 'two files of one directory are one line with their count')
  assert.ok(!plan.includes('state.json') && !plan.includes('trocar-off'), "trocar's own files under ~/.trocar are one sentence")
  assert.doesNotMatch(plan, /Nothing was changed/)
  assert.match(formatUninstallText(receipt({ dry_run: true }), { home, platform: 'darwin', tense: 'future' }), /Nothing was changed/, '--dry-run still says it')
})

test('uninstall: what you must act on stays in the default text: each left row with its command, each problem and note; a refusal adds no Kept line', () => {
  const home = HOMES.darwin
  const left = [{ path: path.join(home, '.codex/.env'), reason: 'could not be parsed', command: `trocar off codex` }]
  const failed = receipt({ ok: false, left, problems: ['the root could not be removed from your trust store'], notes: ['20261109T010000Z stays unsealed until trocar runs again'] })
  const text = formatUninstallText(failed, { home, platform: 'darwin' })
  for (const must of ['    trocar off codex', failed.problems[0], failed.notes[0], '~/.codex/.env']) assert.ok(text.includes(must), `${must}\n${text}`)
  const refused = formatUninstallText(receipt({ ok: false, error: { code: 'collectors-online', message: 'capture is still on for codex' } }), { home, platform: 'darwin' })
  assert.doesNotMatch(refused, /^Kept:/m, 'a refusal changed nothing, so it says nothing about what stays')
  assert.match(formatUninstallText(receipt({ dry_run: true, purge_data: true }), { home, platform: 'darwin', tense: 'future', asking: true }), /captured records/, 'the plan says --purge-data deletes the records')
  assert.equal(countsBy([], (p) => p), '')
})

test('uninstall (§1.4): the trust store and the root key are trocar\'s own, never a file of yours, in any case on Windows', () => {
  const win = HOMES.win32
  const r = receipt({ dry_run: true, changed: [{ path: 'Cert:\\CurrentUser\\Root', change: 'stray root taken out' }, { path: `${win}\\.Codex\\.env`, change: 'taken out' }],
    removed: ['cng:abc', `${win}\\.codex\\.env`] }, 'win32')
  const plan = formatUninstallText(r, { home: win, platform: 'win32', tense: 'future', asking: true })
  assert.doesNotMatch(plan, /Cert:|cng:/)
  assert.equal(plan.split('\n').filter((l) => /\.codex\\\.env/i.test(l)).length, 1, 'one file on Windows, whatever its case')
  const mac = formatUninstallText(receipt({ dry_run: true, changed: [{ path: path.join(HOMES.darwin, 'Library/Keychains/login.keychain-db'), change: 'stray root taken out' }] }), { home: HOMES.darwin, platform: 'darwin', tense: 'future', asking: true })
  assert.doesNotMatch(mac, /Keychains/)
})
