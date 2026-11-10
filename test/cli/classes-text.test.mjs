// test/cli/classes-text.test.mjs — `trocar classes` folds what it writes to stderr at word boundaries (1.6 §1.1⑥): no word is cut across two lines.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { run } from '../../src/cli/classes.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

test('classes: a file it could not read is said on stderr folded at spaces, every word whole on one line', async () => {
  const home = tmpDir('trocar-classes-text-')
  fs.mkdirSync(path.join(home, '.trocar'), { recursive: true })
  fs.writeFileSync(path.join(home, '.trocar', 'classes.json'), `{"version": 1, "classes": [${'"an entry that is not an object", '.repeat(6)}`) // not JSON: its reason names the bytes
  const err = []
  const io = { out: () => {}, err: (l) => err.push(...String(l).split('\n')), isTTY: false }
  const exit = await run([], { io, json: false, args: { positionals: [], flags: {} }, home })
  assert.equal(exit, 0)
  assert.ok(err.length, 'something was said on stderr')
  // a terminal cuts a line past its width wherever the column ends: only a word longer than the width (a path) may pass 80, alone on its line
  assert.deepEqual(err.filter((l) => l.length > 80 && /\S\s+\S/.test(l.trim())), [], 'no line of several words runs past 80 columns')
})
