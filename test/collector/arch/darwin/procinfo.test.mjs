// test/collector/arch/darwin/procinfo.test.mjs — the darwin facts of one pid from recorded `ps` and `lsof -p <pid> -Fn` answers
// (arch/darwin/procinfo.mjs): lsof's FIRST txt record is the executable, a bundle path with spaces stays whole where ps cut it, lsof runs in the
// UTF-8 ctype so names come back as the bytes they are (a `\x20` in its answer is kept, never decoded into a guess), and a killed lsof (its
// timeout) leaves ps's argv[0]. The lab half (a bare-name launch from PATH) is T26's cell.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factsOfPid } from '../../../../src/collector/arch/darwin/procinfo.mjs'

const HELPER = '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper'
const PS = (args) => ({ status: 0, stdout: `  42     1   501 Claude Helper Mon Oct  5 17:00:00 2026     ${args}\n`, stderr: '' })
// lsof -F as recorded: the process record, then cwd, then the txt records — the executable first, then every mapped library
const LSOF = (...txt) => ({ status: 0, stdout: ['p42', 'fcwd', 'n/', ...txt.flatMap((n) => ['ftxt', `n${n}`])].join('\n') + '\n', stderr: '' })

function facts(lsof, args = `${HELPER} --type=renderer`) {
  const asked = []
  const run = (file, a, o) => { asked.push([file, o.env.LC_ALL]); return file === 'ps' ? PS(args) : lsof }
  return { f: factsOfPid(42, { exec: run, env: {} }), asked }
}

test('the first txt record is the executable, not a mapped library after it', () => {
  const { f } = facts(LSOF('/usr/local/bin/claude', '/usr/lib/dyld', '/usr/lib/libSystem.B.dylib'), 'claude --resume')
  assert.equal(f.exe, '/usr/local/bin/claude', 'a bare argv[0] (a PATH launch) is replaced by the real file')
  assert.deepEqual(f.argv, ['claude', '--resume'])
})

test('a Helper path with spaces stays whole — lsof names it, and argv keeps it as one word', () => {
  const { f } = facts(LSOF(HELPER, '/usr/lib/dyld'))
  assert.equal(f.exe, HELPER)
  assert.deepEqual(f.argv, [HELPER, '--type=renderer'])
})

test('lsof runs in the UTF-8 ctype and its name is taken byte for byte — a \\x20 it printed is kept, not decoded', () => {
  const { f, asked } = facts(LSOF('/opt/a\\x20b/agent', '/usr/lib/dyld'), 'agent')
  assert.deepEqual(asked, [['ps', 'C'], ['lsof', 'UTF-8']], 'ps in C (its dates), lsof in UTF-8 (C would print \\xNN for every non-ASCII byte)')
  assert.equal(f.exe, '/opt/a\\x20b/agent')
})

test('a txt record that is no path is skipped; an lsof killed at its timeout leaves ps\'s argv[0]', () => {
  assert.equal(facts(LSOF('(deleted)', '/usr/local/bin/claude'), 'claude').f.exe, '/usr/local/bin/claude')
  const { f } = facts({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync lsof ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, 'claude --resume')
  assert.equal(f.exe, 'claude', 'fail-safe: the word ps printed, which matches no path pattern')
  assert.equal(f.pid, 42)
})
