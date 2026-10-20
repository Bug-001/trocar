// test/helpers/ctime.test.mjs — the helper the stat-signature tests stand on (test/helpers/ctime.mjs): it repeats a change until
// the file's ctime moves, and says so when it never does.
import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changeUntilCtimeMoves } from './ctime.mjs'

// a stat whose ctime holds still for the first `stuck` changes, as the kernel's coarse clock does for a change in the same tick
const clocked = (stuck) => { let runs = 0; return { statSync: () => ({ ctimeMs: 1000 + Math.max(0, runs - stuck) }), tick: () => { runs++ } } }

test('changeUntilCtimeMoves: a ctime that moves on the first change is changed once; one stuck for 3 changes is changed 4 times, 2 ms apart', () => {
  for (const stuck of [0, 3]) {
    const fs = clocked(stuck), at = []
    const [before, after] = changeUntilCtimeMoves(fs, 'f', () => { at.push(performance.now()); fs.tick() })
    assert.equal(at.length, stuck + 1)
    assert.ok(after > before)
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 1.5, `change ${i} came ${at[i] - at[i - 1]} ms after the one before`)
  }
})

test('changeUntilCtimeMoves: a ctime that never moves is an error naming the file and the count, not a pass', () => {
  let n = 0
  assert.throws(() => changeUntilCtimeMoves({ statSync: () => ({ ctimeMs: 5 }) }, '/x/y', () => n++, { tries: 4 }), /\/x\/y: ctime did not move in 4 changes/)
  assert.equal(n, 4)
})

test('changeUntilCtimeMoves: on the real file system a rewrite that restores mtime ends with a ctime different from the one before', () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'trocar-ctime-'))
  try {
    const f = path.join(dir, 'a'), T = Math.floor(Date.now() / 1000) - 60
    nodeFs.writeFileSync(f, 'lorem'); nodeFs.utimesSync(f, T, T)
    const [before, after] = changeUntilCtimeMoves(nodeFs, f, () => { nodeFs.writeFileSync(f, 'Lorem'); nodeFs.utimesSync(f, T, T) })
    assert.notEqual(before, after)
    assert.equal(nodeFs.statSync(f).mtimeMs, T * 1000)
  } finally { nodeFs.rmSync(dir, { recursive: true, force: true }) }
})
