// test/cli/commands.test.mjs — the one table of commands and the help made from it (src/cli/commands.mjs; RFC 1.6 §1.1, §2, §5.4, D58): the list
// src/cli/main.mjs dispatches over. No process, no HOME: the dispatch that runs them is test/cli/dispatch.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMANDS, GROUPS, commandNamed, helpText, usageLine } from '../../src/cli/commands.mjs'
import { optionsOf } from '../../src/cli/args.mjs'
import { WIDTH } from '../../src/cli/text.mjs'

/** The command names a screen of help lists, by the shape of a usage line. */
const commandsOf = (text) => new Set(text.split('\n').map((l) => l.match(/^ {2}(?:sudo )?asight ([a-z-]+)/)).filter(Boolean).map((m) => m[1]))

test('the table is the command list of 1.6 §2 — the names of that list, each once, in three groups', () => {
  const names = COMMANDS.map((c) => c.name)
  assert.deepEqual([...names].sort(), ['classes', 'daemon', 'doctor', 'help', 'install', 'off', 'on', 'query', 'raw', 'serve', 'setup-helper', 'status', 'uninstall'])
  assert.equal(new Set(names).size, names.length, 'a name once')
  for (const gone of ['etl', 'shard', 'keep', 'verify', 'version', 'collector', 'test', 'monitor', 'capture']) {
    assert.equal(commandNamed(gone), undefined, `${gone} is not a command any more (1.6 §6: one feature, one name)`)
  }
  for (const c of COMMANDS) {
    assert.ok(typeof c.run === 'function', `${c.name}: has a run`)
    assert.ok(c.group === null || GROUPS.includes(c.group), `${c.name}: ${c.group}`)
    assert.match(usageLine(c), new RegExp(`^(sudo )?asight ${c.name}\\b`), `${c.name}: every usage line begins with the command`)
    assert.ok(c.summary.split(/(?<=\.)\s/).length >= 2, `${c.name}: two or three sentences of summary`)
    assert.ok(Array.isArray(c.exits) && c.exits.length, `${c.name}: says which exit codes it uses`)
    for (const [code] of c.exits) assert.ok([0, 1, 2, 3, 70].includes(code), `${c.name}: ${code} is one of the five codes of §1.3`)
    assert.ok(typeof c.mutates === 'boolean' || typeof c.mutates === 'function', `${c.name}: says whether it changes state`)
  }
})

test('§1.5: exactly the commands that change your own state refuse root, and setup-helper is the one that needs it', () => {
  assert.deepEqual(COMMANDS.filter((c) => c.mutates === true).map((c) => c.name).sort(), ['daemon', 'install', 'off', 'on', 'uninstall'])
  assert.deepEqual(COMMANDS.filter((c) => c.needsRoot).map((c) => c.name), ['setup-helper'])
  // the two commands where only some subcommands change state (§1.5: `classes set|add|rm|reset` and `raw seal`)
  const asked = (name, word) => commandNamed(name).mutates({ positionals: word === undefined ? [] : [word], flags: {} })
  for (const word of ['set', 'add', 'rm', 'reset']) assert.equal(asked('classes', word), true, `classes ${word}`)
  for (const word of [undefined, 'catalog']) assert.equal(asked('classes', word), false, `classes ${word ?? '(shown)'}`)
  assert.equal(asked('raw', 'seal'), true)
  for (const word of ['verify', 'cat']) assert.equal(asked('raw', word), false, `raw ${word}`)
})

test('D58: every word of help is English ASCII — no section number, decision number, source path or internal code name', () => {
  const texts = [helpText(), ...COMMANDS.map((c) => helpText(c.name))]
  for (const text of texts) {
    assert.ok(/^[\x20-\x7e\n]*$/.test(text), `only printable ASCII: ${text.split('\n').find((l) => !/^[\x20-\x7e]*$/.test(l))}`)
    for (const bad of [/§/, /\bD\d\d\b/, /\bR\d+\b/, /src\/[a-z]/, /\.mjs\b/, /desired-off|left-unparsable|negative-cache/, /undefined|null|NaN/]) {
      assert.ok(!bad.test(text), `${bad} is in:\n${text}`)
    }
  }
})

test('§1.1: help is laid out for 80 columns, in the three groups in order, and lists every command of the table', () => {
  const text = helpText()
  assert.deepEqual([...commandsOf(text)].sort(), COMMANDS.filter((c) => c.group).map((c) => c.name).sort())
  assert.match(text.split('\n').at(-1), /^asight help \[<command>\] {3}asight <command> --help {3}asight --version$/, 'help itself is the trailer (§2)')
  const at = GROUPS.map((g) => text.split('\n').findIndex((l) => l === g))
  assert.ok(at.every((i) => i > 0) && [...at].sort((a, b) => a - b).join() === at.join(), `the three groups in order: ${at}`)
  for (const line of text.split('\n')) assert.ok(line.length <= WIDTH || /^ {2}(sudo )?asight /.test(line), `${line.length} columns: ${line}`) // a usage line is one value: it goes whole, unbroken (§1.1⑥)
  const group = (i) => commandsOf(text.split('\n').slice(at[i], at[i + 1] === undefined ? undefined : at[i + 1]).join('\n'))
  assert.deepEqual([...group(0)].sort(), ['doctor', 'install', 'off', 'on', 'status', 'uninstall'])
  assert.deepEqual([...group(1)].sort(), ['classes', 'query', 'serve'])
  assert.deepEqual([...group(2)].sort(), ['daemon', 'raw', 'setup-helper'])
})

test('§5.4: one command\'s help is its usage, its summary, its options with a line each, and its exit codes; a name that is no command throws', () => {
  const one = helpText('on')
  assert.equal(one.split('\n')[0], 'asight on [<harness>...] [--no-autostart] [--no-unit] [--yes] [--dry-run] [--json]')
  assert.match(one, /\nOptions\n/); assert.match(one, /\nExit codes\n/)
  for (const o of optionsOf(commandNamed('on')).keys()) assert.match(one, new RegExp(`^ {2}${o}\\b`, 'm'), `${o} has its own line`)
  for (const [code] of commandNamed('on').exits) assert.match(one, new RegExp(`^ {2}${code} {2}\\S`, 'm'), `exit ${code} is explained`)
  assert.ok(!/asight uninstall/.test(one), 'one command only')
  assert.match(helpText('raw'), /asight raw seal[\s\S]*asight raw verify[\s\S]*asight raw cat/, 'a command with subcommands says all of them')
  assert.match(helpText('classes'), /asight classes set[\s\S]*asight classes add[\s\S]*asight classes rm[\s\S]*asight classes reset/)
  assert.ok(!/--db|--source|--control/.test(helpText('serve')), 'serve has only --port now (§4.3)')
  assert.throws(() => helpText('nope'), /nope/)
})

test('every command of the table parses its own usage line: every option the usage shows is declared, and nothing is declared twice', () => {
  for (const c of COMMANDS) {
    const declared = [...optionsOf(c).keys()]
    assert.equal(new Set(declared).size, declared.length, `${c.name}: an option once`)
    const shown = [...new Set([...c.usage.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]))].filter((o) => o !== '--help' && o !== '--param')
    for (const o of shown) assert.ok(declared.includes(o) || c.openOptions, `${c.name}: ${o} is in the usage line but not declared`)
    for (const o of declared) assert.ok(c.usage.includes(o), `${c.name}: ${o} is declared but not in the usage line`)
    for (const [, help] of c.options || []) assert.ok(help && /^[\x20-\x7e]+$/.test(help), `${c.name}: every option has one line of ASCII help`)
  }
  assert.ok(optionsOf(commandNamed('status')).has('--json'), 'and the table is the real one')
})
