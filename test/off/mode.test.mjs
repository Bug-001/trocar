// test/off/mode.test.mjs — proxy mode or driver mode (D47), the fact src/off/ keeps its own copy of because the standalone `asight-off`
// runs without the repo (0.1 §2): the two copies MUST agree, or an `off` taken from the copy would steer one way and the collector the
// other. The consequence the copies decide (D62 ⑥): whether an `off` with no names asks the daemon to exit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isProxyMode } from '../../src/off/mode.mjs'
import { isModelOs, MODEL_OS } from '../../src/collector/model-install.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../helpers/imports.mjs'

test('D47: src/off/ and the collector answer "proxy mode?" alike for every platform value either of them can see', () => {
  for (const p of [...MODEL_OS, 'linux', 'freebsd', 'aix', 'android', 'sunos', 'openbsd', undefined, null, '']) {
    assert.equal(isProxyMode(p), isModelOs(p), `the two copies disagree about ${JSON.stringify(p)}`)
  }
  assert.deepEqual([...MODEL_OS].sort(), ['darwin', 'win32'], 'and the list itself is the engine-as-local-proxy pair (D47)')
})

test('D47: nobody writes the pair out by hand — a file of src/cli, src/off or src/netenv that tests `platform` against darwin/win32 itself must say which OTHER fact it is (`not proxy mode:`), or use isProxyMode / isModelOs', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.mjs$/.test(e.name) ? [path.join(d, e.name)] : []))
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  // `<something> === 'darwin' || <something> === 'win32'` (either order), on one line: the shape of a copy of the fact
  const PAIR = /===\s*'(darwin|win32)'\s*\|\|[^\n]{0,40}===\s*'(darwin|win32)'/
  const bad = []
  for (const dir of ['cli', 'off', 'netenv']) {
    for (const f of walk(path.join(REPO, 'src', dir))) {
      const rel = path.relative(REPO, f).split(path.sep).join('/')
      if (rel === 'src/off/mode.mjs') continue // the reader itself
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!PAIR.test(line)) return
        if (/not proxy mode:/.test(line) || /not proxy mode:/.test(lines[i - 1] || '')) return // a different fact, named
        bad.push(`${rel}:${i + 1}`)
      })
    }
  }
  assert.deepEqual(bad, [], 'use isProxyMode (src/off) or isModelOs (the collector), or name the other fact')
})
