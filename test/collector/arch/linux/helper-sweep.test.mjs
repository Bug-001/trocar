// test/collector/arch/linux/helper-sweep.test.mjs — a setup-helper killed between copy and rename leaves a staged
// (possibly capped) copy in the helper dir; the next setup-helper and setup-helper --remove delete exactly those and
// report them (D38: never left behind silently). No root: sweepStaged over a temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepStaged } from '../../../../src/collector/arch/linux/install.mjs'

test('sweepStaged removes only staged helper copies, keeps the current one, and reports what it removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-hs-'))
  try {
    for (const n of ['.trocar-redirector.new.67915', '.trocar-redirector.new.12', 'trocar-redirector', '.trocar-redirector.new.x', 'notes']) fs.writeFileSync(path.join(dir, n), 'x')
    assert.deepEqual(sweepStaged(dir, '.trocar-redirector.new.12').sort(), [path.join(dir, '.trocar-redirector.new.67915')], 'what it removed, as the paths in the dir it swept (the report needs no rebuilding)')
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.trocar-redirector.new.12', '.trocar-redirector.new.x', 'notes', 'trocar-redirector'], 'the helper itself and anything not ours stay')
    assert.deepEqual(sweepStaged(dir), [path.join(dir, '.trocar-redirector.new.12')])
    assert.deepEqual(sweepStaged(path.join(dir, 'gone')), [], 'no helper dir: nothing to do')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
