// voice.test.mjs — 1.6 §1.1 ④ (D58 ⑦, V128): the default text says no word of the UNSAID table, and every fact it leaves out is in --details.
// It asserts those two invariants and the shared helpers' arithmetic, never the wording or the layout of a whole screen (those are looked at).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { andList, countsBy } from '../../src/cli/text.mjs'
import { unsaidIn, loopbackWords } from '../../src/cli/words.mjs'
import { hostTreeNote } from '../../src/collector/core/proxymode/entries.mjs'
import { formatUninstallReceipt, formatUninstallText, formatOnReceipt, formatOnText, formatOnPlan, formatPlan } from '../../src/cli/receipt.mjs'
import { formatModelOnReceipt, formatModelOnText } from '../../src/cli/on-model.mjs'
import { newReceipt } from '../../src/off/schema.mjs'
import { formatOffReceipt, formatOffText, endSentence } from '../../src/off/receipt.mjs'

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
  // the plan is the consent screen: every planned path outside ~/.trocar is there, as itself or as its directory with the count of its files
  const r = receipt({ dry_run: true }), dot = path.join(home, '.trocar')
  const yours = [...r.changed.map((c) => c.path), ...r.removed].filter((p) => p.startsWith(`${home}/`) && !p.startsWith(`${dot}/`))
  for (const p of yours) {
    const dir = path.dirname(p), n = yours.filter((q) => path.dirname(q) === dir).length
    assert.ok(n > 1 ? plan.includes(`~${dir.slice(home.length)} (${n} files)`) : plan.includes(`~${p.slice(home.length)}`), `${p} is in the plan:\n${plan}`)
  }
  assert.ok(yours.length >= 4 && !plan.includes('a.json'), 'the fixture has a shared directory, and its files are one line')
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

test('off (D38): a fact it could not read is in the default text, the conclusion is not a bare "Capture is off", and the plan leaves ~/.trocar to --details', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const home = HOMES[platform], j = (...x) => P(platform).join(home, ...x)
    // the producers' own sentences (src/off/marker.mjs json-value, src/off/undo.mjs readDoorSeen), as they print them
    const notes = [`${j('.codex', 'config.json')}: the file names a loopback proxy, and trocar cannot tell whether it is trocar's own (${j('.trocar', 'collector', 'ingress.json')} is missing); it was left as it is`,
      `trocar's connection record ${j('.trocar', 'collector', 'door-seen.json')} is not JSON, so every running program of an agent that was on is counted as still connected`]
    const flat = (s) => s.replace(/\s+/g, ' ')
    for (const note of notes) {
      const text = formatOffText(offReceipt({ notes: [note] }, platform), { home })
      assert.deepEqual(unsaidIn(text), [], `${platform}:\n${text}`)
      const sought = flat(note.split(home + path.sep).join(`~${path.sep}`)) // HOME as ~, by the host's separator as src/off says it
      assert.ok(flat(text).includes(sought), `${platform}: the note is said:\n${text}`)
      assert.notEqual(text.split('\n')[0], formatOffText(offReceipt({}, platform), { home }).split('\n')[0], 'the conclusion is not the one of an off that read everything')
    }
    const plan = formatOffText(offReceipt({ dry_run: true }, platform), { home }), details = formatOffReceipt(offReceipt({ dry_run: true }, platform), { home })
    assert.ok(!plan.includes('.trocar'), `${platform}: trocar's own files are not in the default plan:\n${plan}`)
    assert.ok(details.includes('switch'), `${platform}: --details keeps them`)
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
    const hostTree = { harness: 'kimi-code', code: 'harness-note', form: 'kimi-code.vscode', text: hostTreeNote('kimi-code.vscode') } // a registered side effect: said once, in the plan
    const pending = { harness: null, code: 'install-pending', item: 'root', state: 'declined', why: 'the trust store said no', command: 'trocar install' } // a form that only forwards (invariant 4)
    const r = { ...onReceipt({}, platform), routes: [{ harness: 'claude-code', route: 'settings', at: j('.claude', 'settings.json'), ok: true }, { harness: 'codex', route: 'env', at: j('.codex', '.env'), ok: true },
      { harness: 'z-code', route: 'cli', at: j('.zcode', 'config.json'), ok: false, code: 'not-routed', reason: 'own-egress' }, { harness: 'z-code', route: 'app', at: j('.zcode', 'app.json'), ok: false, code: 'not-routed', reason: 'blocker' }],
      notes: [{ code: 'loopback-direct', hosts: ['localhost'], text: loopbackWords(['localhost']) }, hostTree, pending] }
    const text = formatModelOnText(r, 1, home), details = formatModelOnReceipt(r, 1, home)
    assert.deepEqual(unsaidIn(text), [], `${platform}:\n${text}`)
    const prose = text.split('\n').filter((l) => !/^ {4}\S/.test(l)).join('\n')
    for (const pid of r.restart.map((x) => x.pid)) { assert.ok(!prose.includes(String(pid)), text); assert.ok(details.includes(String(pid)), `${platform}: --details names ${pid}`) }
    for (const x of r.routes) assert.ok(details.includes(`~${x.at.slice(home.length)}`) || details.includes(x.at), `${platform}: --details names ${x.at}`)
    for (const c of [...r.refused.flatMap((x) => x.commands), 'trocar on z-code']) assert.ok(onItsOwnLine(text, c), `${c}:\n${text}`)
    assert.ok(text.includes(pending.command) && text.includes(pending.why), 'a form that only forwards stays in the default text (invariant 4)')
    for (const n of [hostTree, r.notes[0]]) { assert.ok(!text.includes(n.text), `said once elsewhere, not in the default text:\n${text}`); assert.ok(details.replace(/\s+/g, ' ').includes(n.text), '--details prints it') }
  }
})

// A sentence another module wrote (a refusal's why, a problem, a note a read failed with) reaches on's default text with its internal words
// in it; the default text says them the user's way (plainSentence), --details and --json keep them as written.
test('on: a sentence another module wrote says no unsaid word in the default text, and --details keeps it as written', () => {
  const why = 'the collector did not answer (ECONNREFUSED), so which forms it serves could not be read', problem = 'the daemon was started from other code'
  const linux = onReceipt({ ok: false, refused: [{ harness: 'pi', reason: 'setup-needed', why, commands: ['trocar install'] }], problems: [problem], notes: [problem, `${why}: ENOENT`] })
  const text = formatOnText(linux, { home: HOMES.linux })
  assert.deepEqual(unsaidIn(text), [], text)
  assert.ok(formatOnReceipt(linux, { home: HOMES.linux, platform: 'linux' }).replace(/\s+/g, ' ').includes(problem), '--details keeps the sentence as written')
  for (const platform of ['darwin', 'win32']) {
    const r = { ...onReceipt({}, platform), ok: false, routes: [], refused: [{ harness: 'pi', reason: 'setup-needed', why, commands: ['trocar install'] }], problems: [problem], notes: [{ harness: null, text: `${why} (ENOENT)` }] }
    const shown = formatModelOnText(r, 1, HOMES[platform])
    assert.deepEqual(unsaidIn(shown), [], `${platform}:\n${shown}`)
  }
})

test('uninstall: a refusal (capture on, or the service not answering) is one short line and its steps; --json keeps the full message', () => {
  const home = HOMES.darwin
  const steps = ['Run, in order:', '    trocar off', '    trocar uninstall']
  for (const [daemon, why] of [[{ state: 'left-running', pid: 4242 }, 'the daemon (pid 4242) is running but does not answer (timeout), so capture is not known to be off. Nothing was changed'],
    [{}, 'capture is still on for codex; these processes still have trocar in their environment: pi (pid 5)']]) {
    const r = receipt({ ok: false, daemon, error: { code: 'collectors-online', message: why }, problems: [[why, ...steps].join('\n')] })
    const text = formatUninstallText(r, { home, platform: 'darwin' })
    assert.deepEqual(unsaidIn(text), [], text)
    for (const s of steps.slice(1)) assert.ok(text.split('\n').includes(s), `the step ${s.trim()} is on its own line`)
    assert.match(formatUninstallReceipt(r, { home, platform: 'darwin' }), /pid/, '--details keeps the full sentence')
  }
  // the daemon that stopped answering at the off request: a one-line problem after another one, and the desired state already written
  const silent = receipt({ ok: false, error: { code: 'collectors-online', message: 'the daemon (pid 9) did not answer the off request' },
    problems: ['state.json could not be written (EACCES)', 'the daemon (pid 9) did not answer the off request. Run: trocar off'] })
  const text = formatUninstallText(silent, { home, platform: 'darwin' })
  for (const p of silent.problems) assert.ok(text.replace(/\s+/g, ' ').includes(p), `${p}\n${text}`)
  assert.doesNotMatch(text, /Nothing was changed/, 'it did write the desired state')
})

// 1.6 §3.3: the processes to restart are the subject of the sentence after them, so its verb agrees with how many there are
test('on --details: the restart line says "it" for one process and "they" for more, on every OS', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const home = HOMES[platform]
    for (const [restart, agree, not] of [[[{ harness: 'codex', pid: 5530 }], /\bit connects\b/, /\bthey connect\b/], [[{ harness: 'codex', pid: 5530 }, { harness: 'pi', pid: 6677 }], /\bthey connect\b/, /\bit connects\b/]]) {
      const r = { ...onReceipt({ restart, notes: [] }, platform), routes: [] }
      const details = (platform === 'linux' ? formatOnReceipt(r, { home, platform }) : formatModelOnReceipt(r, 0, home)).replace(/\s+/g, ' ')
      assert.match(details, agree, `${platform}, ${restart.length}:\n${details}`)
      assert.doesNotMatch(details, not)
    }
  }
  const plan = { restart: [{ harness: 'codex', pid: 5530 }], manifest: P('linux').join(HOMES.linux, '.trocar', 'collector', 'install-manifest.json') }
  assert.match(formatPlan(plan, { home: HOMES.linux }).replace(/\s+/g, ' '), /\bit connects\b/, 'the Linux --details plan too')
})

// §1.1: a note is a sentence, and a sentence ends in one mark — none added after one that is there
test('on and off --details: every note ends in exactly one full stop', () => {
  const said = ['which running agents need a restart could not be read (EPERM)', 'the start time of 1 pi process could not be read, so whether it needs a restart is not known', 'the daemon was asked twice.']
  const flat = (s) => s.replace(/\s+/g, ' ')
  const once = (details, n, where) => { const t = n.replace(/\.$/, ''); assert.ok(flat(details).includes(`${t}.`) && !flat(details).includes(`${t}..`), `${where}: ${t}\n${details}`) }
  const linux = formatOnReceipt(onReceipt({ notes: said }), { home: HOMES.linux, platform: 'linux' })
  for (const n of said) once(linux, n, 'linux on')
  for (const platform of ['darwin', 'win32']) {
    const details = formatModelOnReceipt({ ...onReceipt({}, platform), routes: [], notes: said.map((text) => ({ harness: null, text })) }, 0, HOMES[platform])
    for (const n of said) once(details, n, `${platform} on`)
    const off = formatOffReceipt(offReceipt({ notes: said }, platform), { home: HOMES[platform] })
    for (const n of said) once(off, n, `${platform} off`)
  }
  assert.deepEqual(['kept at ~/.trocar/backup/aa-1', 'kept (see above.)', 'run:\n    trocar off', 'kept (~/.codex/.env)'].map(endSentence), ['kept at ~/.trocar/backup/aa-1', 'kept (see above.)', 'run:\n    trocar off', 'kept (~/.codex/.env).'], 'a path, a mark inside a closing ) and a command line end it')
})

test('off --details says once that the daemon keeps running', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const details = formatOffReceipt(offReceipt({}, platform), { home: HOMES[platform] })
    assert.ok(details.split('keeps running').length - 1 <= 1, `${platform}:\n${details}`)
  }
})

// §3.3's --details sample: a route row names the file the setting is in; a route written this run carries no `at`, its plan row has the paths
test('on --details (macOS / Windows): a written route is named by its file, not its route id', () => {
  for (const platform of ['darwin', 'win32']) {
    const home = HOMES[platform], j = (...x) => P(platform).join(home, ...x)
    const planned = [{ harness: 'codex', route: 'env', kind: 'dotenv-block', paths: [j('.codex', '.env')] }, { harness: 'claude-code', route: 'settings', kind: 'json-key', paths: [j('.claude', 'settings.json')] }]
    const r = { ...onReceipt({ restart: [], notes: [] }, platform), planned, routes: planned.map((p) => ({ harness: p.harness, route: p.route, ok: true })) }
    const details = formatModelOnReceipt(r, 0, home)
    for (const p of planned) assert.ok(details.includes(`~${p.paths[0].slice(home.length)}`), `${platform}: names ${p.paths[0]}:\n${details}`)
  }
})

// 1.6 §3.3「要确认时」: a dry run's default plan leaves out the agents already on with every entry intact, and names them in one line; --details and
// --json keep the full plan. Asserted on structure (which paths and names appear), never the wording.
const runOn = async (w, argv) => {
  const { runOnCli } = await import('../../src/cli/on.mjs')
  const out = [], io = { out: (s) => out.push(s), err: (s) => out.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => out.join('\n') }
  const unit = { path: '/nowhere/unit', text: () => '', registered: () => ({ state: 'present' }) }
  const deps = { getuid: () => 501, procs: async () => [], exec: () => ({ status: 0, stdout: '<dictionary> {\n}\n', stderr: '' }), backends: { dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } } }
  const exit = await runOnCli(argv, { io, env: w.env, home: w.home, platform: 'darwin', deps })
  return { exit, text: io.text() }
}
async function inPlaceWorld(onFirst, { commands = ['codex', 'opencode'], apps = [] } = {}) {
  const fs = (await import('node:fs')).default
  const { modelWorld } = await import('../helpers/model-world.mjs')
  const { renderWrapper } = await import('../../src/collector/arch/darwin/wrapper.mjs')
  const { startControlServer } = await import('../../src/collector/core/control.mjs')
  const w = await modelWorld({ os: 'darwin', commands })
  for (const a of apps) fs.mkdirSync(path.join(w.home, 'Applications', a), { recursive: true })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const { tmpDir } = await import('../helpers/tmp.mjs')
  const sock = path.join(tmpDir('sock'), 'c.sock'), token = 't'.repeat(32) // outside HOME: the tree's bytes are compared
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  const first = await runOn(w, [...onFirst, '--yes'])
  assert.equal(first.exit, 0, first.text)
  const planned = JSON.parse((await runOn(w, ['--dry-run', '--json'])).text).planned.filter((p) => p.route)
  const pathsOf = (h) => planned.filter((p) => p.harness === h).flatMap((p) => p.paths)
  const named = (text, f) => text.includes(f) || text.includes(`~${f.slice(w.home.length)}`)
  return { w, fs, server, planned, pathsOf, named }
}

test('on --dry-run (macOS): every agent already on with its entries intact → no plan row, one line names them all, exit 0, nothing written', async () => {
  const { snapshot } = await import('./fixtures/on-ctx.mjs')
  const { w, server, pathsOf, named } = await inPlaceWorld(['codex', 'opencode'])
  try {
    assert.ok(pathsOf('codex').length && pathsOf('opencode').length)
    const before = snapshot(w.home)
    const dry = await runOn(w, ['--dry-run'])
    assert.equal(dry.exit, 0, dry.text)
    for (const f of [...pathsOf('codex'), ...pathsOf('opencode')]) assert.ok(!named(dry.text, f), `no plan row names ${f}\n${dry.text}`)
    assert.ok(dry.text.split('\n').some((l) => l.includes('codex') && l.includes('opencode')), `one line names both\n${dry.text}`)
    assert.deepEqual(snapshot(w.home), before, 'nothing written')
  } finally { await server.close() }
})

test('on --dry-run (macOS): one of two agents already on → the plan rows name only the other\'s files, one line names the one already on', async () => {
  const { w, server, pathsOf, named } = await inPlaceWorld(['codex'])
  try {
    const dry = await runOn(w, ['--dry-run'])
    assert.equal(dry.exit, 0, dry.text)
    for (const f of pathsOf('codex')) assert.ok(!named(dry.text, f), `codex is not in the plan: ${f}\n${dry.text}`)
    for (const f of pathsOf('opencode')) assert.ok(named(dry.text, f), `opencode is in the plan: ${f}\n${dry.text}`)
    assert.ok(dry.text.split('\n').some((l) => l.includes('codex') && !l.includes('opencode')), `one line names codex\n${dry.text}`)
  } finally { await server.close() }
})

test('on --dry-run (macOS): an agent whose entry is no longer intact is in the plan, not named as already on', async () => {
  const { w, fs, server, pathsOf, named } = await inPlaceWorld(['codex', 'opencode'])
  try {
    const f = pathsOf('codex')[0]
    fs.writeFileSync(f, 'EDITED_BY_USER=1\n')
    const dry = await runOn(w, ['--dry-run'])
    assert.equal(dry.exit, 0, dry.text)
    assert.ok(named(dry.text, f), `codex's changed file is in the plan\n${dry.text}`)
    for (const g of pathsOf('opencode')) assert.ok(!named(dry.text, g), `opencode is still in place: ${g}\n${dry.text}`)
  } finally { await server.close() }
})

test('on --dry-run (macOS): an agent turned off in the desired state (an off cut short) is in the plan, not named as already on', async () => {
  const { w, fs, server, pathsOf, named } = await inPlaceWorld(['codex', 'opencode'])
  try {
    const stateF = path.join(w.dir, 'state.json'), st = JSON.parse(fs.readFileSync(stateF, 'utf8'))
    st.harnesses.codex.desired = 'off'
    fs.writeFileSync(stateF, JSON.stringify(st))
    const dry = await runOn(w, ['--dry-run'])
    for (const f of pathsOf('codex')) assert.ok(named(dry.text, f), `codex is in the plan: ${f}\n${dry.text}`)
    for (const g of pathsOf('opencode')) assert.ok(!named(dry.text, g), `opencode is still in place: ${g}\n${dry.text}`)
  } finally { await server.close() }
})

test('on --dry-run (macOS): an agent whose record is for another file than the one planned (its home moved) is in the plan', async () => {
  const { w, fs, server, pathsOf, named } = await inPlaceWorld(['codex', 'opencode'])
  try {
    const f = pathsOf('codex')[0], moved = `${f}.before-move`
    fs.copyFileSync(f, moved)
    const { readManifest, saveManifest } = await import('../../src/off/manifest.mjs')
    const m = readManifest(w.dir, fs)
    let n = 0
    for (const e of [...(m.entries || []), ...(m.files || [])]) if (e.harness === 'codex' && e.path === f) { e.path = moved; if (e.real_path) e.real_path = moved; n++ }
    assert.ok(n > 0, 'the sandbox recorded codex at its planned file')
    saveManifest(w.dir, m, fs)
    const dry = await runOn(w, ['--dry-run'])
    assert.ok(named(dry.text, f), `codex's planned file is in the plan\n${dry.text}`)
  } finally { await server.close() }
})

test('on --dry-run (macOS): a route that writes into a folder (Claude\'s config library) is in place when its entry file is intact', async () => {
  const { w, server, planned } = await inPlaceWorld(['claude-code', 'codex'], { commands: ['claude', 'codex'], apps: ['Claude.app'] })
  try {
    const lib = planned.find((p) => p.harness === 'claude-code' && p.paths.some((f) => !path.extname(f)))
    assert.ok(lib, `the sandbox plans a folder route\n${JSON.stringify(planned)}`)
    const dry = await runOn(w, ['--dry-run'])
    assert.ok(!dry.text.split('\n').some((l) => l.startsWith('  claude-code')), `no plan row for claude-code\n${dry.text}`)
    assert.ok(dry.text.split('\n').some((l) => l.includes('claude-code') && l.includes('codex')), `one line names both\n${dry.text}`)
  } finally { await server.close() }
})

test('on --dry-run --details / --json (macOS): agents already on keep their full plan', async () => {
  const { w, server, planned, named } = await inPlaceWorld(['codex', 'opencode'])
  try {
    assert.deepEqual([...new Set(planned.map((p) => p.harness))].sort(), ['codex', 'opencode'], '--json planned is whole')
    const details = (await runOn(w, ['--dry-run', '--details'])).text
    for (const f of planned.flatMap((p) => p.paths)) assert.ok(named(details, f), `--details names ${f}\n${details}`)
  } finally { await server.close() }
})
