// test/cli/text.test.mjs — the one text layer of the human-facing CLI (src/cli/text.mjs; RFC 1.6 §1.1, D58): aligned columns, label/value blocks,
// `~` for the home directory, 1000-based sizes, relative time, `unknown(reason)`, and colour only when a person is looking.
import test from 'node:test'
import assert from 'node:assert/strict'
import { colors, useColor, noColor, columns, pairs, tilde, size, ago, unknown, wrap, WIDTH } from '../../src/cli/text.mjs'

const io = (isTTY) => ({ stdout: { isTTY } })

test('D58: colour only when stdout is a terminal, NO_COLOR unset; FORCE_COLOR forces it; without colour not one ANSI byte', () => {
  assert.equal(useColor(io(false), {}), false)
  assert.equal(useColor(io(true), {}), true)
  assert.equal(useColor(io(true), { NO_COLOR: '1' }), false, 'NO_COLOR wins over the terminal')
  assert.equal(useColor(io(false), { FORCE_COLOR: '1' }), true, 'FORCE_COLOR wins over a pipe')
  assert.equal(useColor(io(true), { NO_COLOR: '1', FORCE_COLOR: '1' }), false, 'NO_COLOR wins over FORCE_COLOR')
  assert.equal(useColor(null, {}), false)
  const plain = colors(io(false), {})
  for (const k of ['green', 'yellow', 'red', 'dim', 'bold']) assert.equal(plain[k]('x'), 'x', k)
  const c = colors(io(true), {})
  for (const k of ['green', 'yellow', 'red', 'dim', 'bold']) {
    assert.match(c[k]('x'), /\u001b\[\d+m.*x.*\u001b\[\d+m/, k)
    assert.equal(c[k]('x').replace(/\u001b\[\d+m/g, ''), 'x', `${k}: the text itself is untouched`)
  }
  for (const k of ['green', 'yellow', 'red', 'dim', 'bold']) assert.equal(noColor()[k]('x'), 'x', k)
})

test('columns: every column as wide as its widest cell, one space-padded gap, no trailing blanks, an empty list is an empty list', () => {
  assert.deepEqual(columns([['a', 'bb', 'c'], ['aaa', 'b', 'cc']]), ['a    bb  c', 'aaa  b   cc'])
  assert.deepEqual(columns([['a', 'b']], { gap: 1 }), ['a b'])
  assert.deepEqual(columns([['a', '']]), ['a'], 'an empty last cell leaves no trailing space')
  assert.deepEqual(columns([]), [])
  assert.deepEqual(columns([['one']]), ['one'])
  assert.deepEqual(columns([['a', 'b'], ['c']]), ['a  b', 'c'], 'a short row is not padded to the missing cells')
})

test('columns with a width: a last cell past it folds on spaces under its own column; a word longer than the room is never broken', () => {
  assert.deepEqual(columns([['ab', 'a b c d e'], ['c', 'f']], { width: 8 }), ['ab  a b', '    c d', '    e', 'c   f'])
  assert.deepEqual(columns([['ab', 'a-word-past-the-room end']], { width: 12 }), ['ab  a-word-past-the-room', '    end'])
  assert.deepEqual(columns([['a-head-past-the-width', ''], ['b', 'x']], { width: 10 }), ['a-head-past-the-width', 'b                      x'], 'a blank last cell keeps its row')
})

test('pairs: a label/value block aligned on the label, indented; a value longer than the line gets its own line, unbroken', () => {
  assert.deepEqual(pairs([['state', 'on'], ['daemon', 'running']]), ['  state   on', '  daemon  running'])
  assert.deepEqual(pairs([['a', 'b']], { indent: 0 }), ['a  b'])
  const long = 'x'.repeat(WIDTH)
  assert.deepEqual(pairs([['path', long]]), ['  path', `  ${long}`], 'the long value is whole, on its own line')
})

test('pairs: every folded line fills up to the width, the lines under a label as much as the first (§1.1⑥)', () => {
  for (const width of [30, 47, 80]) {
    for (const words of [12, 40]) {
      const value = Array.from({ length: words }, (_, i) => 'w'.repeat(1 + ((i * 7) % 9))).join(' ')
      const out = pairs([['autostart', value], ['a', 'b']], { width })
      const col = out.at(-1).indexOf('b')
      const rows = out.slice(0, -1).map((l) => l.slice(col).split(' '))
      for (const [i, line] of out.slice(0, -1).entries()) {
        assert.ok(line.length <= width, `width ${width}: ${JSON.stringify(line)} is past the width`)
        if (i < rows.length - 1) assert.ok(line.length + 1 + rows[i + 1][0].length > width, `width ${width}: line ${i} stops short: the next word fits on it`)
      }
      assert.deepEqual(rows.flat(), value.split(' '), 'every word, in order, in the value column')
    }
  }
})

test('pairs: a later word too long for the value column takes its own line at the fold column, never past the width (§1.1⑥)', () => {
  for (const len of [30, 60, 70]) {
    const word = 'p'.repeat(len)
    const value = `key -> trocar (backup ${word}) tail`
    const out = pairs([['~/.claude/settings.json', value]])
    for (const line of out) assert.ok(line.length <= WIDTH, `word of ${len}: ${JSON.stringify(line)} is past the width`)
    assert.deepEqual(out.join(' ').split(/\s+/).filter(Boolean), ['~/.claude/settings.json', ...value.split(' ')], 'every word, once, in order')
  }
  const huge = 'q'.repeat(WIDTH)
  const out = pairs([['label', `a ${huge} b`]])
  assert.ok(out.some((l) => l.trim() === huge), 'a word longer than any column is whole, alone on its line')
})

test('tilde: the home directory becomes ~, and only at the start of a path', () => {
  assert.equal(tilde('/home/u/.trocar/raw', '/home/u'), '~/.trocar/raw')
  assert.equal(tilde('/home/u', '/home/u'), '~')
  assert.equal(tilde('/home/user2/x', '/home/u'), '/home/user2/x', 'not a prefix of the path\'s own segments')
  assert.equal(tilde('/var/log/home/u', '/home/u'), '/var/log/home/u')
  assert.equal(tilde('C:\\Users\\u\\.trocar', 'C:\\Users\\u'), '~\\.trocar')
  assert.equal(tilde(undefined, '/home/u'), undefined)
  assert.equal(tilde('/home/u/x', ''), '/home/u/x', 'no home, no shortening')
})

test('size: KB MB GB by 1000, one decimal above a kilobyte, bytes as themselves', () => {
  assert.deepEqual([size(0), size(1), size(999)], ['0 B', '1 B', '999 B'])
  assert.deepEqual([size(1000), size(1500), size(999_000)], ['1.0 KB', '1.5 KB', '999.0 KB'])
  assert.deepEqual([size(1_000_000), size(128_000_000)], ['1.0 MB', '128.0 MB'])
  assert.deepEqual([size(2_500_000_000), size(1e13)], ['2.5 GB', '10000.0 GB'])
  assert.equal(size(null), unknown(), 'what is not a number is unknown, never NaN')
})

test('ago: relative time in whole units, the future and the unreadable say so', () => {
  const now = Date.parse('2026-10-18T12:00:00Z')
  const at = (iso) => ago(iso, now)
  assert.equal(at('2026-10-18T11:59:55Z'), 'just now')
  assert.equal(at('2026-10-18T11:59:00Z'), '1 min ago')
  assert.equal(at('2026-10-18T11:30:00Z'), '30 min ago')
  assert.equal(at('2026-10-18T11:00:00Z'), '1 h ago')
  assert.equal(at('2026-10-17T12:00:00Z'), '1 d ago')
  assert.equal(at('2026-10-18T12:00:30Z'), 'just now', 'a clock a little ahead is not "in -1 min"')
  assert.equal(at('2026-10-19T12:00:00Z'), 'in 1 d')
  assert.equal(at('not a time'), unknown('unreadable time'))
  assert.equal(at(undefined), unknown('no time recorded'))
})

test('unknown: the one way to say a value could not be read — never undefined, null or blank', () => {
  assert.equal(unknown(), 'unknown')
  assert.equal(unknown('the daemon does not answer'), 'unknown (the daemon does not answer)')
  assert.equal(unknown(''), 'unknown')
  assert.equal(unknown(undefined), 'unknown')
})

test('wrap: lines of at most 80 columns, broken on spaces; a word longer than the line keeps its own', () => {
  assert.deepEqual(wrap('a b c', 3), ['a b', 'c'])
  assert.deepEqual(wrap('one two three', 80), ['one two three'])
  assert.deepEqual(wrap('x'.repeat(90), 80), ['x'.repeat(90)], 'never broken mid-word')
  assert.deepEqual(wrap('  a   b  ', 80), ['a b'], 'runs of whitespace are one space')
  assert.deepEqual(wrap('', 80), [])
  for (const l of wrap('word '.repeat(60))) assert.ok(l.length <= WIDTH, l)
})

// §1.1⑥: a command named in a sentence never splits across lines — at every width, each command in the text is whole on one line
test('wrap: a `trocar <command>` with its options, and a backquoted command, stay on one line at every width', () => {
  const cmds = ['trocar uninstall', 'trocar install.', 'trocar uninstall --purge-data', '`sudo /opt/node/bin/node /opt/trocar/bin/trocar.mjs setup-helper`']
  const text = `If you suspect misuse: ${cmds[0]}, then ${cmds[1]} To delete what was kept, run ${cmds[2]} or install the helper with ${cmds[3]}; then run trocar on.`
  for (let width = 10; width <= 130; width++) {
    const lines = wrap(text, width)
    assert.equal(lines.join(' '), text.replace(/\s+/g, ' '), `${width}: no word lost`)
    for (const c of cmds) assert.ok(lines.some((l) => l.includes(c)), `${width}: ${c} whole on one line:\n${lines.join('\n')}`)
  }
})
