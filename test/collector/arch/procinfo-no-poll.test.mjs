// test/collector/arch/procinfo-no-poll.test.mjs — 4.8 W2's static half: a process is asked about at the moment its connection reaches a
// door, never by polling — no snapshot diff, no demand-poll, no candidate set. So no arch's procinfo.mjs starts a timer loop (comments excluded).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { findIn } from '../../helpers/code-text.mjs'

const ARCH = new URL('../../../src/collector/arch/', import.meta.url)
const POLL = /\bset(Interval|Immediate)\s*\(|\bsetTimeout\s*\([^)]*\bpoll/g
const polls = (name, text) => findIn(text, POLL, { strings: false }).map((h) => `${name}:${h.line} ${h.text}`)

test('W2: no procinfo.mjs of any arch polls (setInterval / setImmediate loop)', () => {
  const files = fs.readdirSync(ARCH, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(new URL(`${e.name}/procinfo.mjs`, ARCH))).map((e) => `${e.name}/procinfo.mjs`)
  assert.ok(files.includes('win32/procinfo.mjs'), 'the scan sees the Windows procinfo W2 is about')
  assert.deepEqual(files.flatMap((f) => polls(f, fs.readFileSync(new URL(f, ARCH), 'utf8'))), [])
})

test('W2: the scan goes red on a seeded poll, and not on the word in a comment or a string', () => {
  assert.deepEqual(polls('x', "// setInterval(scan, 1000)\nconst t = setInterval(() => snapshot(), 500)\nconst s = 'setInterval('"), ['x:2 setInterval('])
})
