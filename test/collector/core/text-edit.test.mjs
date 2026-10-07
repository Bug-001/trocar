// test/collector/core/text-edit.test.mjs — the sentinel block and sentinel line asight writes into comment-capable
// files (RFC 4.6 §身份与信任「标记与安装」「同名键」, §安装清单与卸载「撤一个文件的规则」; T10 / T11 text parts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, reverseOps } from '../../../src/collector/core/trust/json-text.mjs'
import { parseDotenv } from '../../../src/collector/core/config-read.mjs'
import { dotenvBlock, insertLine, removeAsightText, onlySkeleton, BLOCK_BEGIN, BLOCK_END, OFF_PREFIX, SENTINEL, lineComment } from '../../../src/collector/core/trust/text-edit.mjs'

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
