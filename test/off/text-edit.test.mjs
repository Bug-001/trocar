// test/off/text-edit.test.mjs — the sentinel block and sentinel line asight writes into comment-capable
// files (RFC 4.6 §身份与信任「标记与安装」「名字族」, §安装清单与卸载「撤一个文件的规则」; T10 / T11 text parts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, reverseOps } from '../../src/off/json-text.mjs'
import { dotenvBlock, joinDotenvBlock, insertLine, removeAsightText, asightResidue, onlySkeleton, BLOCK_BEGIN, BLOCK_END, OFF_PREFIX, SENTINEL, lineComment } from '../../src/off/text-edit.mjs'
import { parseDotenv } from '../../src/collector/core/config-read.mjs'

const B = '/h/.asight/collector/ca/combined-x.pem'

test('text-edit: the dotenv block goes on top, unquoted, LF; a user line with the same key is put out of effect, both in ops', () => {
  const user = 'OPENAI_API_KEY=sk-secret\nexport SSL_CERT_FILE="/corp/ca.pem" # mine\nOTHER=1'
  const r = dotenvBlock(user, { SSL_CERT_FILE: B })
  assert.ok(r.text.startsWith(`${BLOCK_BEGIN}\nSSL_CERT_FILE=${B}\n${BLOCK_END}\n`), 'block first, value unquoted, LF only')
  assert.ok(!r.text.includes('\r'))
  assert.ok(r.text.includes(`\n${OFF_PREFIX}export SSL_CERT_FILE="/corp/ca.pem" # mine\n`), 'the user line keeps every byte behind the prefix')
  assert.deepEqual(r.prior, { SSL_CERT_FILE: '/corp/ca.pem' })
  assert.equal(r.ops.length, 2)
  assert.ok(r.ops.every((o) => o.removed === ''), 'nothing of the user file is carried in the ops')
  assert.ok(!JSON.stringify(r.ops).includes('sk-secret'))
  assert.equal(applyOps(user, r.ops), r.text)
  assert.equal(reverseOps(r.text, r.ops), user, 'untouched → byte-identical undo')
  assert.equal(dotenvBlock(null, { SSL_CERT_FILE: B }).text, `${BLOCK_BEGIN}\nSSL_CERT_FILE=${B}\n${BLOCK_END}\n`, 'a missing file holds only the block')
  assert.equal(dotenvBlock('A=1\n', { SSL_CERT_FILE: B }).prior, null)
  assert.throws(() => dotenvBlock('', { SSL_CERT_FILE: '/a b/c.pem' }), /unquoted absolute paths only/)
  assert.throws(() => dotenvBlock('', { SSL_CERT_FILE: '/a/$HOME.pem' }), /unquoted absolute paths only/)
})

test('text-edit: a sentinel line goes after the last line it must follow; one carrying no sentinel is refused', () => {
  const rc = '# rc\nexport PATH="$HOME/.kimi-code/bin:$PATH"\nalias ll=ls\n'
  const line = `export PATH="/h/.asight/collector/bin:$PATH" ${lineComment('kimi shim')}`
  const r = insertLine(rc, { line, after: '\\.kimi-code/bin' })
  assert.equal(r.text, `# rc\nexport PATH="$HOME/.kimi-code/bin:$PATH"\n${line}\nalias ll=ls\n`)
  assert.equal(reverseOps(r.text, r.ops), rc)
  assert.equal(insertLine('A=1', { line }).text, `A=1\n${line}\n`, 'a last line without a newline gets one before asight\'s')
  assert.throws(() => insertLine(rc, { line, after: 'nowhere' }), /no line matches/)
  assert.throws(() => insertLine(rc, { line: 'export PATH=/x:$PATH' }), /sentinel/)
  assert.throws(() => insertLine(rc, { line: `${line}\nmore` }), /one line/)
})

test('text-edit: a YAML list row — absent / empty / [] / block list; anything else is refused', () => {
  const row = `- insert: [{ name: "/h/.asight/collector/plugins/dsh/index.js" }] ${lineComment('dsh plugin')}`
  assert.equal(insertLine(null, { line: row, format: 'yaml-list' }).text, `${row}\n`)
  assert.equal(insertLine('', { line: row, format: 'yaml-list' }).text, `${row}\n`)
  const empty = insertLine('# nothing yet\n[]\n', { line: row, format: 'yaml-list' })
  assert.equal(empty.text, `# nothing yet\n${row}\n`)
  assert.deepEqual(empty.ops, [{ offset: 14, removed: '[]', inserted: row }], 'the [] asight replaced is all that is carried')
  assert.equal(reverseOps(empty.text, empty.ops), '# nothing yet\n[]\n')
  const list = '- set:\n    llm-deepseek.config.model: x\n- insert: [{ name: mine }]'
  const r = insertLine(list, { line: row, format: 'yaml-list' })
  assert.equal(r.text, `${list}\n${row}\n`)
  assert.equal(reverseOps(r.text, r.ops), list)
  assert.throws(() => insertLine('llm: {}\n', { line: row, format: 'yaml-list' }), /not a block-style YAML list/)
})

test('text-edit: after the user edited the file, only asight\'s block / lines go, the user\'s line comes back, the rest stays byte for byte', () => {
  const user = 'K=sk-secret\nSSL_CERT_FILE=/corp/ca.pem\n'
  const r = dotenvBlock(user, { SSL_CERT_FILE: B, HERMES_CA_BUNDLE: B })
  const edited = `# the user's note\n${r.text}NEW=2\n`
  assert.equal(reverseOps(edited, r.ops), null, 'offsets moved: the plain reverse refuses')
  const out = removeAsightText(edited, r.ops)
  assert.deepEqual(out, { text: `# the user's note\n${user}NEW=2\n`, found: true })
  const row = `- insert: [{ name: "/p/index.js" }] ${lineComment('dsh plugin')}`
  const y = insertLine('[]', { line: row, format: 'yaml-list' })
  assert.deepEqual(removeAsightText(`- set: {a: 1}\n${y.text}`, y.ops), { text: '- set: {a: 1}\n[]', found: true }, 'the [] asight replaced is put back')
  const rcLine = `export PATH="/b:$PATH" ${lineComment('kimi shim')}`
  const rc = insertLine('A\n', { line: rcLine })
  assert.deepEqual(removeAsightText(`before\n${rc.text}after\n`, rc.ops), { text: 'before\nA\nafter\n', found: true })
  assert.deepEqual(removeAsightText(`before\n${rc.text.trimEnd()}`, rc.ops), { text: 'before\nA\n', found: true }, 'asight\'s line found though the user cut its newline')
  const noEnd = r.text.replace(`${BLOCK_END}\n`, '')
  assert.deepEqual(removeAsightText(noEnd, r.ops), { text: user, found: true }, 'a block whose end marker the user deleted still goes, line by line')
  assert.deepEqual(removeAsightText(user, r.ops), { text: user, found: false }, 'nothing of asight left: nothing changes')
  assert.ok(SENTINEL.length > 0 && BLOCK_END.includes(SENTINEL))
})

// The audit's HIGH finding (semantics 1): the removal read only the exact bytes asight wrote, so a file an editor had touched (CRLF, trailing blanks, an `export`) reported
// "asight's text is no longer in this file" while the assignment was still there — and `off` then deleted the bundle it named.
test('text-edit: asight\'s block is found the way an editor leaves it — CRLF, blanks, indent, `export`, spaces around =, quotes, a trailing comment, a BOM, a copy — and the user\'s own lines stay', () => {
  const user = 'KEY=sk-secret\nSSL_CERT_FILE=/corp/ca.pem\n'
  const r = dotenvBlock(user, { SSL_CERT_FILE: B })
  const asLF = r.text
  const forms = {
    crlf: (t) => t.replace(/\n/g, '\r\n'),
    'trailing blanks': (t) => t.replace(/\n/g, ' \t\n'),
    indent: (t) => t.replace(/^(?=.)/gm, '  '),
    export: (t) => t.replace(/^SSL_CERT_FILE=/m, 'export SSL_CERT_FILE='),
    'spaces around =': (t) => t.replace(new RegExp(`^SSL_CERT_FILE=${B}`, 'm'), `SSL_CERT_FILE = ${B}`),
    'double quotes': (t) => t.replace(`SSL_CERT_FILE=${B}`, `SSL_CERT_FILE="${B}"`),
    'single quotes + comment': (t) => t.replace(`SSL_CERT_FILE=${B}`, `SSL_CERT_FILE='${B}'  # mine`),
    BOM: (t) => `\uFEFF${t}`,
  }
  for (const [name, edit] of Object.entries(forms)) {
    const edited = edit(asLF)
    if (name !== 'BOM') assert.equal(reverseOps(edited, r.ops), null, `${name}: the plain reverse refuses a file that is not what asight wrote`)
    const out = removeAsightText(edited, r.ops)
    assert.equal(out.found, true, name)
    assert.ok(!out.text.includes(B) && !out.text.includes(BLOCK_BEGIN) && !out.text.includes(BLOCK_END), `${name}: nothing of asight's is left: ${JSON.stringify(out.text)}`)
    assert.deepEqual(asightResidue(out.text, { vars: { SSL_CERT_FILE: B } }), [], name)
    const own = out.text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean)
    assert.deepEqual(own.map((l) => l.replace(/^\uFEFF/, '')), ['KEY=sk-secret', 'SSL_CERT_FILE=/corp/ca.pem'], `${name}: the user's own lines stay, the one asight put out of effect is back in effect`)
  }
  // a BOM is the file's, not asight's: it stays where it was
  assert.ok(removeAsightText(`\uFEFF${asLF}`, r.ops).text.startsWith('\uFEFFKEY=sk-secret'))
  // a copy of the assignment (the user pasted the block twice): an agent that reads the last one would still get the bundle, so every one goes
  const twice = `${asLF}${asLF.split('\n').slice(1, 2).join('\n')}\n`
  assert.equal((twice.match(new RegExp(B, 'g')) || []).length, 2)
  assert.ok(!removeAsightText(twice, r.ops).text.includes(B))
  // the value of the same key the USER set is not asight's: another path stays untouched
  const own = `${asLF}SSL_CERT_FILE=${B}.mine\n`
  assert.ok(removeAsightText(own, r.ops).text.includes(`SSL_CERT_FILE=${B}.mine`))
  // the last line without a newline: the line before keeps its own
  assert.equal(removeAsightText(`A=1\nSSL_CERT_FILE=${B}`, [{ offset: 0, removed: '', inserted: `${BLOCK_BEGIN}\nSSL_CERT_FILE=${B}\n${BLOCK_END}\n` }]).text, 'A=1\n')
})

test('text-edit: asightResidue names the lines (outside comments) that still hold a path asight put there — a dotenv value, an asight path in a rc line or a YAML row — and nothing else', () => {
  const vars = { SSL_CERT_FILE: B, HERMES_CA_BUNDLE: B }
  assert.deepEqual(asightResidue(`A=1\nSSL_CERT_FILE=${B};\n# was ${B}\nB=2\nHERMES_CA_BUNDLE=\${B}\n`, { vars }), [2], 'a form the removal cannot read still names the file; a comment does not')
  assert.deepEqual(asightResidue('A=1\n', { vars }), [])
  assert.deepEqual(asightResidue(`A=1\n`, {}), [], 'an entry that names no path of its own has no residue')
  const row = `- insert: [{ name: "/h/.asight/collector/plugins/dsh/index.js" }] ${lineComment('dsh plugin')}`
  assert.deepEqual(asightResidue(`- set: {a: 1}\n- insert: [ { name: "/h/.asight/collector/plugins/dsh/index.js" } ]\n`, { line: row }), [2], 'a YAML row the user re-spaced still loads the plugin')
  assert.deepEqual(asightResidue('- set: {a: 1}\n', { line: row }), [])
  assert.deepEqual(asightResidue('export PATH="/h/.asight/collector/bin:$PATH"\n', { line: `export PATH="/h/.asight/collector/bin:$PATH" ${lineComment('kimi shim')}` }), [1])
})

test('text-edit: what counts as only asight\'s skeleton — blank for every format; comments too for a YAML list', () => {
  assert.equal(onlySkeleton('\n  \n', 'line'), true)
  assert.equal(onlySkeleton('# a user comment\n', 'line'), false, 'a comment the user wrote in an rc or .env is theirs')
  assert.equal(onlySkeleton('# a comment\n\n', 'yaml-list'), true, 'dsh will not start on a patch file with no list in it')
  assert.equal(onlySkeleton('- set: {}\n', 'yaml-list'), false)
})

// ── CRLF files (a .env edited on Windows) and a value with a space (a profile directory like C:\Users\John Smith) ──
test('text-edit: a CRLF file — the user\'s same-key lines are put out of effect and priors recorded, the block uses the file\'s line ending, and undo is byte for byte', () => {
  const user = 'OPENAI_API_KEY=sk-secret\r\nexport SSL_CERT_FILE="C:/corp/ca.pem" # mine\r\nHTTPS_PROXY=http://corp:3128\r\n# a comment\r\n'
  const r = dotenvBlock(user, { SSL_CERT_FILE: B, HTTPS_PROXY: 'http://g:tok@127.0.0.1:17991' })
  assert.deepEqual(r.prior, { SSL_CERT_FILE: 'C:/corp/ca.pem', HTTPS_PROXY: 'http://corp:3128' }, 'the \\r at the end of a line does not hide the assignment')
  assert.ok(r.text.includes(`\r\n${OFF_PREFIX}export SSL_CERT_FILE="C:/corp/ca.pem" # mine\r\n`) && r.text.includes(`\r\n${OFF_PREFIX}HTTPS_PROXY=http://corp:3128\r\n`), 'both user lines are behind the prefix, every byte kept')
  assert.ok(r.text.startsWith(`${BLOCK_BEGIN}\r\nSSL_CERT_FILE=${B}\r\nHTTPS_PROXY=http://g:tok@127.0.0.1:17991\r\n${BLOCK_END}\r\n`), 'the block is CRLF like the file')
  assert.ok(!/[^\r]\n/.test(r.text), 'no bare LF anywhere: an editor that keeps a file\'s line ending does not mix it')
  assert.equal(reverseOps(r.text, r.ops), user, 'untouched → byte-identical undo')
  assert.ok(r.ops.every((o) => o.removed === ''))
  // a file of bare LF stays LF, a file with no line ending at all gets LF, a mixed file follows the line ending most of its lines have
  assert.ok(!dotenvBlock('A=1\nB=2\n', { SSL_CERT_FILE: B }).text.includes('\r'))
  assert.ok(!dotenvBlock('A=1', { SSL_CERT_FILE: B }).text.includes('\r'))
  assert.ok(dotenvBlock('A=1\r\nB=2\r\nC=3\n', { SSL_CERT_FILE: B }).text.startsWith(`${BLOCK_BEGIN}\r\n`))
  assert.ok(dotenvBlock('A=1\nB=2\r\nC=3\n', { SSL_CERT_FILE: B }).text.startsWith(`${BLOCK_BEGIN}\nSSL`))
})

test('text-edit: after the user edited the file, asight\'s block is found whichever line ending an editor left it with, and the user\'s line comes back', () => {
  const user = 'K=1\r\nSSL_CERT_FILE=C:/corp/ca.pem\r\n'
  const r = dotenvBlock(user, { SSL_CERT_FILE: B })
  const edited = `# the user's note\r\n${r.text}NEW=2\r\n`
  assert.deepEqual(removeAsightText(edited, r.ops), { text: `# the user's note\r\n${user}NEW=2\r\n`, found: true }, 'CRLF block, CRLF file')
  assert.deepEqual(removeAsightText(edited.replace(/\r\n/g, '\n'), r.ops), { text: `# the user's note\nK=1\nSSL_CERT_FILE=C:/corp/ca.pem\nNEW=2\n`, found: true }, 'an editor that rewrote the whole file with LF: the block still goes, the rest is as the editor left it')
  const lf = dotenvBlock('K=1\nSSL_CERT_FILE=/corp/ca.pem\n', { SSL_CERT_FILE: B })
  assert.deepEqual(removeAsightText(lf.text.replace(/\n/g, '\r\n'), lf.ops), { text: 'K=1\r\nSSL_CERT_FILE=/corp/ca.pem\r\n', found: true }, 'an LF block in a file an editor made CRLF')
})

test('text-edit: a value with a space is written double-quoted only when the entry asks for it (Windows profiles); a value that needs no quote stays unquoted; what a quoted value cannot hold is still refused', () => {
  const W = 'C:/Users/John Smith/.asight/collector/ca/combined-x.pem'
  assert.throws(() => dotenvBlock('', { SSL_CERT_FILE: W }), /unquoted absolute paths only/, 'the default is the unquoted-only rule, as on Linux')
  const r = dotenvBlock('K=1\n', { SSL_CERT_FILE: W, HTTPS_PROXY: 'http://g:t@127.0.0.1:1' }, { quote: true })
  assert.ok(r.text.startsWith(`${BLOCK_BEGIN}\nSSL_CERT_FILE="${W}"\nHTTPS_PROXY=http://g:t@127.0.0.1:1\n${BLOCK_END}\nK=1\n`), 'only the value that has a space is quoted')
  assert.equal(reverseOps(r.text, r.ops), 'K=1\n')
  assert.equal(parseDotenv(r.text).get('SSL_CERT_FILE'), W, 'the reader gets the path back without the quotes')
  assert.equal(dotenvBlock('', { SSL_CERT_FILE: B }, { quote: true }).text, `${BLOCK_BEGIN}\nSSL_CERT_FILE=${B}\n${BLOCK_END}\n`, 'nothing to quote: byte for byte the unquoted block')
  for (const bad of ['C:/a "b"/c.pem', 'C:/a b/$HOME.pem', 'C:/a b/`x`.pem', 'C:\\a b\\c.pem', 'C:/a b/c.pem\nX=1', 'C:/a b/c.pem\r']) assert.throws(() => dotenvBlock('', { SSL_CERT_FILE: bad }, { quote: true }), /cannot be written|unquoted absolute paths only/, JSON.stringify(bad))
  assert.equal(dotenvBlock('', { SSL_CERT_FILE: "C:/Users/O'Brien (x86)/ca.pem" }, { quote: true }).text.split('\n')[1], `SSL_CERT_FILE="C:/Users/O'Brien (x86)/ca.pem"`, 'a single quote and brackets are fine inside double quotes')
})

// D39③ / task 3: the text asight put into users' files before this build must stay recognisable (the sentinel is how an install the
// manifest has lost, or a standalone asight-off, finds its own block and line — 1.6 R3). Pinned as literals: a test that imports the
// constants would follow a changed constant and stay green.
// Windows (4.8 §2.3): a profile directory with a space makes the block's value a double-quoted one (`quote: true`). The removal that reads every assignment of asight's path
// (D39 R3) must read that line back to the plain path: a copy the user pasted, with `export` or single quotes, goes too, and the user's own same-key line stays.
test('text-edit: a block written double-quoted (a profile with a space) is removed with every copy of its path, in whichever form, and the user\'s own value of the key is not touched', () => {
  const W = 'C:/Users/John Smith/.asight/collector/ca/combined-x.pem'
  const user = 'KEY=sk-secret\r\nSSL_CERT_FILE=C:/corp/ca.pem\r\n'
  const r = dotenvBlock(user, { SSL_CERT_FILE: W }, { quote: true })
  assert.ok(r.text.includes(`SSL_CERT_FILE="${W}"`), 'the block holds the quoted form')
  const alone = removeAsightText(r.text, r.ops)
  assert.deepEqual(alone, { text: user, found: true }, 'untouched: back to the user\'s bytes')
  const copies = `${r.text}export SSL_CERT_FILE='${W}'\r\nSSL_CERT_FILE = "${W}" # pasted\r\nSSL_CERT_FILE="${W}.mine"\r\n`
  const out = removeAsightText(copies, r.ops)
  assert.equal(out.found, true)
  assert.ok(!out.text.includes(`"${W}"`) && !out.text.includes(`'${W}'`) && !out.text.includes(BLOCK_BEGIN), `no copy of asight's path is left: ${JSON.stringify(out.text)}`)
  assert.ok(out.text.includes(`SSL_CERT_FILE="${W}.mine"`), 'another value of the key is the user\'s')
  const noMine = removeAsightText(copies.replace(/SSL_CERT_FILE="[^"]*\.mine"\r\n/, ''), r.ops)
  assert.deepEqual(asightResidue(noMine.text, { vars: { SSL_CERT_FILE: W } }), [], 'and nothing of asight\'s path is reported as left behind')
})

test('text-edit: the sentinel text written into users\' files is exactly what earlier builds wrote', () => {
  assert.equal(SENTINEL, 'asight collector')
  assert.equal(BLOCK_BEGIN, '# >>> asight collector >>> written by `asight collector install`; `asight collector uninstall` removes this block')
  assert.equal(BLOCK_END, '# <<< asight collector <<<')
  assert.equal(OFF_PREFIX, '#asight-collector-off# ')
  assert.equal(lineComment('Kimi shim'), '# asight collector: Kimi shim (`asight collector uninstall` removes this line)')
})

test('text-edit X6: a byte-order mark (U+FEFF at offset 0) stays first — the block goes after it, a key on the first line is read after it and put out of effect after it; undo gives the text back', () => {
  const user = '\uFEFFSSL_CERT_FILE=/corp/ca.pem\r\nOTHER=1\r\n'
  const r = dotenvBlock(user, { SSL_CERT_FILE: B })
  assert.ok(r.text.startsWith(`\uFEFF${BLOCK_BEGIN}\r\n`), JSON.stringify(r.text.slice(0, 80)))
  assert.ok(r.text.includes(`\r\n${OFF_PREFIX}SSL_CERT_FILE=/corp/ca.pem\r\n`), 'the first line\'s key is out of effect, the mark not moved')
  assert.equal((r.text.match(/\uFEFF/g) || []).length, 1)
  assert.deepEqual(r.prior, { SSL_CERT_FILE: '/corp/ca.pem' })
  assert.equal(reverseOps(r.text, r.ops), user)
  assert.equal(removeAsightText(r.text, r.ops).text, user)
  const j = joinDotenvBlock(r.text, { HTTPS_PROXY: 'http://127.0.0.1:1' })
  assert.ok(j.text.startsWith(`\uFEFF${BLOCK_BEGIN}\r\n`) && j.text.includes(`HTTPS_PROXY=http://127.0.0.1:1\r\n${BLOCK_END}`))
  const y = insertLine('\uFEFF', { line: `- r ${lineComment('x')}`, format: 'yaml-list' })
  assert.equal(y.text, `\uFEFF- r ${lineComment('x')}\n`, 'a file holding only the mark is an empty list: no blank line before the row')
})

test('text-edit ③: one eolOf decides every insert — CRLF when CRLF outnumbers bare LF, else LF, LF for an empty or new file; rc and YAML rows follow it', () => {
  const eolOf = (t) => (/\r\n$/.test(insertLine(t, { line: `x ${lineComment('k')}` }).text) ? '\r\n' : '\n') // what an rc line ends with
  assert.deepEqual([eolOf(null), eolOf(''), eolOf('a'), eolOf('a\r\nb\n'), eolOf('a\r\nb\r\nc\n'), eolOf('a\nb\n')], ['\n', '\n', '\n', '\n', '\r\n', '\n'])
  const rc = insertLine('export A=1\r\nalias x=y', { line: `export PATH=p ${lineComment('k')}` })
  assert.equal(rc.text, `export A=1\r\nalias x=y\r\nexport PATH=p ${lineComment('k')}\r\n`)
  const after = insertLine('export PATH=/kimi/bin\r\nB=2\r\n', { line: `export PATH=p ${lineComment('k')}`, after: '^export PATH=/kimi/bin$' })
  assert.equal(after.text, `export PATH=/kimi/bin\r\nexport PATH=p ${lineComment('k')}\r\nB=2\r\n`, 'a line\'s own \\r is not part of what `after` matches')
  const yml = insertLine('- a\r\n# note\r\n', { line: `- r ${lineComment('x')}`, format: 'yaml-list' })
  assert.equal(yml.text, `- a\r\n# note\r\n- r ${lineComment('x')}\r\n`, 'a CRLF comment line is still a comment line')
})

// D48② (X8): a key asight's block set that the user set to a value of their own while asight was on — inside the block or outside it — keeps the user's value after off;
// the user's old line asight put out of effect stays out of effect and is reported by its line; a key the user did not touch gets its old line back. Key by key, not the
// whole text: a prefixed line of a key this entry did not set is not this entry's.
test('text-edit X8: the user\'s new value of a key asight set wins — its old line stays out of effect (prior_left, by line), another key\'s old line comes back; in either line ending', () => {
  for (const eol of ['\n', '\r\n']) {
    const user = ['OPENAI_API_KEY=sk-x', 'HTTPS_PROXY=http://corp:8080', 'SSL_CERT_FILE=/corp/ca.pem', ''].join(eol)
    const r = dotenvBlock(user, { SSL_CERT_FILE: B, HTTPS_PROXY: 'http://127.0.0.1:1' })
    const inBlock = r.text.replace('HTTPS_PROXY=http://127.0.0.1:1', 'HTTPS_PROXY=http://newcorp:3128')
    assert.deepEqual(removeAsightText(inBlock, r.ops), {
      text: ['HTTPS_PROXY=http://newcorp:3128', 'OPENAI_API_KEY=sk-x', `${OFF_PREFIX}HTTPS_PROXY=http://corp:8080`, 'SSL_CERT_FILE=/corp/ca.pem', ''].join(eol),
      found: true, prior_left: [{ key: 'HTTPS_PROXY', line: 3 }],
    }, `in the block, ${JSON.stringify(eol)}`)
    const outside = `${r.text}export SSL_CERT_FILE = "/mine/ca.pem"${eol}`
    const out = removeAsightText(outside, r.ops)
    assert.deepEqual(out.prior_left, [{ key: 'SSL_CERT_FILE', line: 3 }], 'a line of its own after the block')
    assert.equal(parseDotenv(out.text).get('SSL_CERT_FILE'), '/mine/ca.pem')
    assert.equal(parseDotenv(out.text).get('HTTPS_PROXY'), 'http://corp:8080', 'the key the user did not touch is back to their old value')
    assert.ok(!out.text.includes('127.0.0.1') && !out.text.includes(B) && !out.text.includes(BLOCK_BEGIN))
  }
  // the mark on the first line: the prefix is after it, the line number is the user's
  const marked = dotenvBlock('﻿SSL_CERT_FILE=/corp/ca.pem\n', { SSL_CERT_FILE: B })
  const m = removeAsightText(`${marked.text}SSL_CERT_FILE=/mine.pem\n`, marked.ops)
  assert.deepEqual(m, { text: `﻿${OFF_PREFIX}SSL_CERT_FILE=/corp/ca.pem\nSSL_CERT_FILE=/mine.pem\n`, found: true, prior_left: [{ key: 'SSL_CERT_FILE', line: 1 }] })
  // a prefixed line of a key this entry did not set is another entry's: it is not touched
  const r = dotenvBlock('A=1\n', { SSL_CERT_FILE: B })
  const other = `${OFF_PREFIX}HTTPS_PROXY=http://corp:8080\n`
  assert.deepEqual(removeAsightText(`${r.text}${other}`, r.ops), { text: `A=1\n${other}`, found: true })
  assert.deepEqual(removeAsightText(`A=1\n${other}`, r.ops), { text: `A=1\n${other}`, found: false }, 'nothing of this entry\'s left: nothing changes')
})

test('text-edit X8: `fold` (4.6「名字族」) compares the keys without case — a lower-case name the user set is the new value of asight\'s upper-case one; asight\'s value under another case goes too', () => {
  const user = 'https_proxy=http://corp:8080\n'
  const r = { ops: [{ offset: 0, removed: '', inserted: `${BLOCK_BEGIN}\nHTTPS_PROXY=http://127.0.0.1:1\n${BLOCK_END}\n` }, { offset: 0, removed: '', inserted: OFF_PREFIX }] }
  const on = `${BLOCK_BEGIN}\nHTTPS_PROXY=http://127.0.0.1:1\n${BLOCK_END}\n${OFF_PREFIX}${user}`
  const edited = on.replace('HTTPS_PROXY=http://127.0.0.1:1', 'https_proxy=http://newcorp:3128')
  assert.deepEqual(removeAsightText(edited, r.ops, { fold: true }), { text: `https_proxy=http://newcorp:3128\n${OFF_PREFIX}${user}`, found: true, prior_left: [{ key: 'https_proxy', line: 2 }] })
  assert.deepEqual(removeAsightText(on, r.ops, { fold: true }), { text: user, found: true }, 'untouched: the old line is back')
  assert.deepEqual(removeAsightText(on.replace('HTTPS_PROXY=', 'Https_Proxy='), r.ops, { fold: true }), { text: user, found: true }, 'asight\'s value under another case is asight\'s')
  assert.equal(removeAsightText(on.replace('HTTPS_PROXY=', 'Https_Proxy='), r.ops).text.includes('127.0.0.1'), true, 'without fold another case is another name')
})
