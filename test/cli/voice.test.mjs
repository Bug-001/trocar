// voice.test.mjs — 1.6 §1.1 ④ (D58 ⑦, V128): the default text says no word of the UNSAID table, and every fact it leaves out is in --details.
// It asserts those two invariants and the shared helpers' arithmetic, never the wording or the layout of a whole screen (those are looked at).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { andList, countsBy } from '../../src/cli/text.mjs'
import { unsaidIn } from '../../src/cli/words.mjs'
import { formatUninstallReceipt, formatUninstallText, formatOnReceipt, formatOnText, formatOnPlan } from '../../src/cli/receipt.mjs'
import { formatModelOnReceipt, formatModelOnText } from '../../src/cli/on-model.mjs'
import { newReceipt } from '../../src/off/schema.mjs'
import { formatOffReceipt, formatOffText } from '../../src/off/receipt.mjs'

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

// an off with something of every kind its receipt can hold: files restored, one with your later edits, a backup kept, the service, a cut, processes
// still passing through, a file it could not undo (with the line that puts it back) and one the user must fix by a command
const offReceipt = (over = {}, platform = 'darwin') => {
  const home = HOMES[platform], j = (...x) => P(platform).join(home, ...x)
  return {
    ...newReceipt('off'), ok: true, all: true, harnesses: ['claude-code', 'codex', 'pi'], still_on: [],
    changed: [{ path: j('.claude', 'settings.json'), harness: 'claude-code', change: 'env.HTTPS_PROXY', result: 'restored', backup: j('.trocar', 'backup', 'aa-1') },
      { path: j('.codex', '.env'), harness: 'codex', change: 'HTTPS_PROXY', result: 'reverted-not-identical', backup: j('.trocar', 'backup', 'bb-2'), prior_left: [{ key: 'HTTPS_PROXY', line: 3 }] }],
    removed: [j('.trocar', 'collector', 'switch', 'pi')], skipped: [],
    kept_backups: [{ path: j('.claude', 'settings.json'), backup: j('.trocar', 'backup', 'cc-3'), reason: 'you changed it after trocar did' }],
    daemon: { state: 'running', pid: 4012 }, relayed: { closing: 2, waiting: 0, cut: 0 }, routing: { confirmed: true, state: 'stopped' },
    holders: [{ harness: 'codex', pid: 5530 }, { harness: 'codex', pid: 5531 }, { harness: 'pi', pid: 6677 }],
    left: [], pending: [], residue: [], still_trusting: [], kept_bundles: [], user_processes: [], problems: [], notes: [], ...over,
  }
}
const pidsOf = (r) => [...(r.holders || []).map((h) => h.pid), ...(r.daemon && r.daemon.pid ? [r.daemon.pid] : [])]
const commandsOf = (r) => [...(r.left || []).flatMap((l) => [l.command, l.restore]), ...(r.blocked || []).map((b) => b.command), ...(r.refused || []).flatMap((x) => x.commands || [x.command])].filter(Boolean)
const onItsOwnLine = (text, command) => text.split('\n').some((l) => l.trim() === command)

test('off: the default text says no unsaid word and no pid; --details holds every path and pid; every command is on a line of its own', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const home = HOMES[platform], j = (...x) => P(platform).join(home, ...x)
    const failed = offReceipt({ ok: false, left: [{ path: j('.zcode', 'config.json'), harness: 'z-code', result: 'left-unparsable', reason: `${j('.zcode', 'config.json')}: trocar cannot read it; trocar's proxy setting may still be in it. The file as it was before trocar is kept at ${j('.trocar', 'backup', 'dd-4')}; by hand: cp a b (puts the whole file back)`, backup: j('.trocar', 'backup', 'dd-4'), restore: 'cp a b' },
      { path: j('.kimi', 'x'), result: 'error', reason: 'it is locked', command: 'trocar off kimi-code' }], routing: { confirmed: false, state: 'unknown' }, notes: ['the process table could not be read (permission denied)'] }, platform)
    for (const r of [offReceipt({}, platform), failed, offReceipt({ dry_run: true }, platform), offReceipt({ holders: null }, platform)]) {
      const text = formatOffText(r, { home }), details = formatOffReceipt(r, { home })
      assert.deepEqual(unsaidIn(text), [], `${platform}:\n${text}`)
      for (const pid of pidsOf(r)) assert.ok(!text.includes(String(pid)), `${platform}: no pid in the default text:\n${text}`)
      for (const pid of pidsOf(r)) assert.ok(details.includes(String(pid)), `${platform}: --details names pid ${pid}`)
      const paths = [...r.changed.map((c) => c.path), ...r.removed, ...r.kept_backups.map((k) => k.backup), ...r.left.map((l) => l.path)]
      for (const p of paths) assert.ok(details.includes(`~${p.slice(home.length)}`) || details.includes(p), `${platform}: --details names ${p}`) // src/off shows ~ by the host's separator
      for (const c of commandsOf(r)) assert.ok(onItsOwnLine(text, c), `${platform}: ${c} on its own line:\n${text}`)
      if (r.notes.length) assert.ok(text.includes(r.notes[0]), 'a fact not read stays in the default text (D38)')
      if (r.dry_run) for (const c of r.changed) assert.ok(text.includes(`~${c.path.slice(home.length)}`) || text.includes(c.path), 'the plan names each file of yours')
    }
  }
})

// an on with what its receipt can hold: files changed with backups, trocar's own files, processes to restart, a refusal with its commands, a
// blocked step with its command, notes said once (loopback) and a problem
const onReceipt = (over = {}, platform = 'linux') => {
  const home = HOMES[platform], j = (...x) => P(platform).join(home, ...x)
  return {
    ...newReceipt('on'), ok: true, harnesses: ['claude-code', 'codex'], user: 'alice', linger: true, daemon: { state: 'running', pid: 4012 },
    changed: [{ path: j('.claude', 'settings.json'), change: 'env.HTTPS_PROXY -> trocar', backup: j('.trocar', 'backup', 'aa-1') }],
    created: [j('.trocar', 'collector', 'state.json')], unchanged: [], skipped: [],
    restart: [{ harness: 'codex', pid: 5530 }, { harness: 'codex', pid: 5531 }],
    refused: [{ harness: 'pi', reason: 'setup-needed', why: 'its certificate setting is missing', commands: ['trocar install'] }],
    blocked: [{ what: 'trocar on', reason: 'the helper is missing', command: 'sudo /usr/bin/node /opt/trocar/bin/trocar.mjs setup-helper' }],
    notes: ['requests to localhost, 127.0.0.1, ::1 (a model or relay on this computer) do not go through trocar and are not captured'], problems: [], ...over,
  }
}

test('on (Linux): the default plan and receipt say no unsaid word and no pid; --details holds every path and pid; every command is on a line of its own', () => {
  const home = HOMES.linux, r = onReceipt()
  const text = formatOnText(r, { home }), details = formatOnReceipt(r, { home, platform: 'linux' })
  assert.deepEqual(unsaidIn(text), [], text)
  for (const pid of [...r.restart.map((x) => x.pid), r.daemon.pid]) { assert.ok(!text.includes(String(pid)), text); assert.ok(details.includes(String(pid)), `--details names ${pid}`) }
  for (const p of [...r.changed.flatMap((c) => [c.path, c.backup]), ...r.created]) assert.ok(details.includes(`~${p.slice(home.length)}`), `--details names ${p}`)
  for (const c of commandsOf(r)) assert.ok(onItsOwnLine(text, c), `${c}:\n${text}`)
  assert.match(text, /^Restart codex to capture it/m, 'the processes started before are one line (§3.3)')
  assert.ok(!text.includes('127.0.0.1'), 'the loopback note is said once, in --details')
  const plan = { targets: ['claude-code', 'pi'], first: false, newPaths: [r.changed[0].path], entries: [{ harness: 'claude-code', path: r.changed[0].path, keys: ['env', 'HTTPS_PROXY'] }], manifest: P('linux').join(home, '.trocar', 'collector', 'install-manifest.json') }
  const shown = formatOnPlan(plan, { home })
  assert.deepEqual(unsaidIn(shown), [], shown)
  assert.match(shown, /claude-code\s+~\/\.claude\/settings\.json\s+new$/m, 'a file not confirmed last time ends in new')
  assert.match(shown, /^ {2}pi\s+no file of yours$/m)
  assert.ok(!shown.includes('.trocar') && !shown.includes('HTTPS_PROXY'), "trocar's own files and the keys are --details facts")
  assert.doesNotMatch(formatOnPlan({ ...plan, first: true }, { home }), /new$/m, 'the first on after install marks nothing new')
})

test('on (macOS / Windows): the default receipt says no unsaid word and no pid; --details holds every path and pid; every command is on a line of its own', () => {
  for (const platform of ['darwin', 'win32']) {
    const home = HOMES[platform], j = (...x) => P(platform).join(home, ...x)
    const r = { ...onReceipt({}, platform), routes: [{ harness: 'claude-code', route: 'settings', at: j('.claude', 'settings.json'), ok: true }, { harness: 'codex', route: 'env', at: j('.codex', '.env'), ok: true }],
      notes: [{ code: 'loopback-direct', hosts: ['localhost'], text: 'requests to localhost are not captured' }, { harness: 'codex', code: 'harness-note', form: 'codex.vscode', text: 'codex.vscode runs inside another program: trocar passes those connections on without capturing them' }] }
    const text = formatModelOnText(r, 1, home), details = formatModelOnReceipt(r, 1, home)
    assert.deepEqual(unsaidIn(text), [], `${platform}:\n${text}`)
    for (const pid of r.restart.map((x) => x.pid)) { assert.ok(!text.includes(String(pid)), text); assert.ok(details.includes(String(pid)), `${platform}: --details names ${pid}`) }
    for (const x of r.routes) assert.ok(details.includes(`~${x.at.slice(home.length)}`) || details.includes(x.at), `${platform}: --details names ${x.at}`)
    for (const c of r.refused.flatMap((x) => x.commands)) assert.ok(onItsOwnLine(text, c), `${c}:\n${text}`)
    assert.ok(text.includes('codex.vscode runs inside another program'), 'a form that only forwards stays in the default text (invariant 4)')
    assert.ok(!text.includes('requests to localhost'), 'the loopback note is --details only')
  }
})
