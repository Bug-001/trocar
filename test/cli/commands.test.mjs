// test/cli/commands.test.mjs — the table of commands, the hidden aliases and the help made from them (src/cli/commands.mjs; RFC 1.6 §2, R7, R10; V19's table half). No process, no HOME: the dispatch that
// runs them is test/cli/dispatch.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMANDS, HIDDEN_ALIASES, helpText, resolveAlias, commandNamed } from '../../src/cli/commands.mjs'

const commandsOf = (text) => new Set(text.split('\n').map((l) => l.match(/^ {2}(?:sudo )?asight ([a-z-]+)/)).filter(Boolean).map((m) => m[1]))

test('V19: the commands in help are the commands of the table (1.6 §2 lists these twelve — the old capture\'s five went with it, D39⑥ executed 2026-10-11; shard stayed and moved to data), none twice a command, and no hidden alias or `test` is among them', () => {
  const names = COMMANDS.map((c) => c.name)
  assert.deepEqual([...names].sort(), ['daemon', 'doctor', 'etl', 'help', 'keep', 'off', 'on', 'raw', 'serve', 'setup-helper', 'shard', 'status', 'uninstall'])
  assert.equal(new Set(names).size, names.length, 'a name once')
  for (const platform of ['linux', 'darwin', 'win32']) assert.deepEqual([...commandsOf(helpText(undefined, { platform }))].sort(), [...names].sort(), platform)
  assert.deepEqual([...commandsOf(helpText())].sort(), [...names].sort(), 'with no platform given: this one')
  const hidden = new Set(HIDDEN_ALIASES.map((a) => a.argv[0]))
  assert.deepEqual([...hidden].sort(), ['collector', 'install', 'verify'])
  for (const h of [...hidden, 'test']) assert.ok(!commandsOf(helpText()).has(h), `${h} is not in help`)
  assert.ok(!names.includes('test'), '`asight test` is gone: it was doctor\'s alias and the name npm test already has (1.6 §2)')
  for (const c of COMMANDS) assert.ok(typeof c.run === 'function' && c.usage && c.summary && ['common', 'data', 'maintenance'].includes(c.section), c.name)
})

test('the hidden aliases are the table of 1.6 §2, and resolveAlias puts what an alias names in its place and keeps the rest of the arguments as typed (the longest alias wins)', () => {
  assert.deepEqual(HIDDEN_ALIASES.map((a) => `${a.argv.join(' ')} → ${a.to.join(' ')}`), [
    'install → on', 'collector install → on', 'collector on → on', 'collector off → off', 'collector status → status', 'collector uninstall → uninstall', 'collector start → daemon', 'verify → doctor --only old-ca',
  ])
  for (const a of HIDDEN_ALIASES) assert.ok(commandNamed(a.to[0]), `${a.argv.join(' ')} names a command of the table`)
  assert.deepEqual(resolveAlias(['collector', 'install', '--no-unit', '--yes', 'claude']), { argv: ['on', '--no-unit', '--yes', 'claude'], alias: HIDDEN_ALIASES[1] })
  assert.deepEqual(resolveAlias(['install', '--dry-run']).argv, ['on', '--dry-run'])
  assert.deepEqual(resolveAlias(['verify']).argv, ['doctor', '--only', 'old-ca'])
  assert.deepEqual(resolveAlias(['collector', 'start']).argv, ['daemon'])
  for (const argv of [['on'], ['collector'], ['collector', 'bogus'], ['collect', 'on'], ['installx'], []]) assert.deepEqual(resolveAlias(argv), { argv, alias: null }, argv.join(' '))
})

test('R7: exactly the per-user commands that change state refuse root (on off uninstall daemon keep), and setup-helper is the one that needs it', () => {
  assert.deepEqual(COMMANDS.filter((c) => c.mutates).map((c) => c.name).sort(), ['daemon', 'keep', 'off', 'on', 'uninstall'])
  assert.deepEqual(COMMANDS.filter((c) => c.needsRoot).map((c) => c.name), ['setup-helper'])
})

test('help: the first screen says on, off and status and that they drive the per-process collector here; the three sections are in order (the 旧采集 section went with the old capture, D39⑥ executed 2026-10-11); helpText(name) is one command, and a name that is none throws', () => {
  const lines = (platform) => helpText(undefined, { platform }).split('\n')
  assert.match(lines('linux').slice(0, 6).join('\n'), /开 asight on · 关 asight off · 状态 asight status/)
  assert.match(lines('linux').slice(0, 8).join('\n'), /本平台\(linux\):on \/ off 驱动按进程采集器/)
  assert.match(lines('darwin').slice(0, 8).join('\n'), /本平台\(darwin\):on \/ off 驱动按进程采集器/, 'darwin prints the same line as linux\'s')
  assert.match(lines('win32').slice(0, 8).join('\n'), /本平台\(win32\):on \/ off 驱动按进程采集器/, 'win32 prints the same line as linux\'s')
  assert.match(lines('freebsd').slice(0, 8).join('\n'), /本平台\(freebsd\):on \/ off 驱动按进程采集器/, 'one wording for every platform: a platform without a collector is loadArch\'s refusal, not the help\'s')
  const text = helpText(undefined, { platform: 'linux' })
  const at = ['常用', '数据', '维护'].map((h) => text.split('\n').findIndex((l) => l.startsWith(h)))
  assert.ok(at.every((i) => i > 0) && [...at].sort((a, b) => a - b).join() === at.join(), `the three sections in order: ${at}`)
  assert.ok(!/旧采集|过渡期/.test(text), 'the old capture\'s section and its mark are gone')
  for (const c of ['capture', 'mitm', 'desktop', 'monitor']) assert.ok(!new RegExp(`^ {2}asight ${c}\\b`, 'm').test(text), `${c} is not a command any more`)
  const section = (from, to) => commandsOf(text.split('\n').slice(at[from], at[to]).join('\n'))
  assert.deepEqual([...section(0, 1)].sort(), ['doctor', 'off', 'on', 'status', 'uninstall'])
  assert.deepEqual([...section(1, 2)].sort(), ['etl', 'keep', 'raw', 'serve', 'shard'], 'raw export | journal are data; keep (D40) is what is kept of the data; shard (the sessions ingestion) moved here from the retired section')
  assert.deepEqual([...section(2, 3)].sort(), ['daemon', 'help', 'raw', 'setup-helper'], 'raw seal | verify | compare are maintenance')
  const one = helpText('off')
  assert.match(one, /asight off \[harness…\] \[--now\] \[--dry-run\] \[--yes\] \[--json\]/)
  assert.ok(!/asight serve/.test(one), 'one command only')
  assert.match(helpText('raw'), /asight raw export[\s\S]*asight raw journal[\s\S]*asight raw seal[\s\S]*asight raw verify[\s\S]*asight raw compare/, 'raw says all of it')
  assert.throws(() => helpText('nope'), /nope/)
})
