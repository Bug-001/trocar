// test/scripts/run-through-link.test.mjs — a script run through a symbolic link does its work. The checkout that develops trocar reaches
// `scripts/*.mjs` through links, and a main guard that compared the link's path with the module's own (real) path never ran `main`:
// the script exited 0 having done nothing, which is a failure nobody is told of (D38).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const script = fileURLToPath(new URL('../../scripts/count-tests.mjs', import.meta.url))

test('a script run through a symbolic link runs its main, as when run by its own path', () => {
  const dir = tmpDir('trocar-link-')
  const out = path.join(dir, 'run.txt')
  fs.writeFileSync(out, ['tests 3', 'pass 3', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0'].map((l) => `ℹ ${l}`).join('\n') + '\n')
  const link = path.join(dir, 'count-tests.mjs')
  fs.symlinkSync(script, link)
  for (const entry of [script, link]) {
    const r = spawnSync(process.execPath, [entry, 'read', out, 'darwin', '22'], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).tests, 3, `${entry}: ${JSON.stringify(r.stdout)}`)
  }
})
