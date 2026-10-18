// english.mjs — the D58 check every human-facing output of a command must pass (spec 1.6 §1.1): English only, nothing a reader cannot act on,
// and 80 columns. One place, so a new command's test says `assertEnglish(text)` and inherits every rule.
import assert from 'node:assert/strict'
import { WIDTH } from '../../src/cli/text.mjs'

const BAD = [
  [/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/, 'CJK or fullwidth characters'],
  [/\bundefined\b|\bNaN\b/, 'a value that could not be read, printed as a program sees it'],
  [/(^|[\s(:=])null([\s).,;]|$)/, 'null'],
  [/§/, 'a section number'],
  [/\bD\d{2}\b/, 'a decision number'],
  [/<[a-z][a-z -]*>/, 'an unfilled placeholder'],
  [/\n\s+at [^\s]+:\d+:\d+/, 'a stack trace'],
]

/** Asserts `text` is output a person can read (D58): English, ASCII, no internal numbers, no unread value, every line inside 80 columns. */
export function assertEnglish(text, where = 'the output') {
  const bare = String(text).replace(/\u001b\[\d+m/g, '')
  for (const [re, what] of BAD) assert.ok(!re.test(bare), `${where} holds ${what}:\n${bare}`)
  for (const ch of bare) assert.ok(ch.codePointAt(0) < 128, `${where} is not ASCII (${JSON.stringify(ch)}):\n${bare}`)
  for (const line of bare.split('\n')) assert.ok(line.length <= WIDTH, `${where} has a line of ${line.length} columns (max ${WIDTH}):\n${line}`)
}
