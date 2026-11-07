// 1.6 §1.1: a note says what is so in words. `on` for a harness whose installed carrier cannot be read (pi's extension, its directory not
// readable) keeps the errno as the note's `code` and the file in it, and does not print Node's error text as its sentence.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'

const neverStarts = { path: '/nowhere/unit', text: () => '', registered: () => ({ state: 'present' }), enable: () => ({ code: 1 }), start: () => ({ code: 1 }), startNow: () => ({ code: 1 }) }

for (const os of ['darwin', 'win32']) {
  test(`on (${os}): a carrier that cannot be read is a note with the errno as its code and the file in its words, not Node's message`, async (t) => {
    if (process.getuid && process.getuid() === 0) return t.skip('root reads any file')
    const w = await modelWorld({ os, env: (home) => ({ PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent') }) })
    fs.mkdirSync(path.join(w.home, '.pi', 'agent', 'install'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.pi', 'agent', 'install', 'current-version'), '1\n')
    assert.equal((await w.install()).exit, 0)
    const ext = path.join(w.home, '.pi', 'agent', 'extensions')
    assert.ok(fs.readdirSync(ext).length, 'install placed the extension')
    fs.chmodSync(ext, 0o000)
    try {
      const io = fakeIo()
      const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: { os, harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
      await runOnCli(['pi', '--dry-run', '--json'], { io, env: w.env, home: w.home, platform: os, deps })
      const notes = JSON.parse(io.stdoutText()).notes.filter((n) => n && n.harness === 'pi')
      assert.equal(notes.length, 1, JSON.stringify(notes))
      const [n] = notes
      assert.equal(n.code, 'EACCES', 'the errno is the note\'s code')
      assert.ok(n.text.includes(ext), `the file is named: ${n.text}`)
      assert.ok(!n.text.includes(n.code), `the errno is the code, not the sentence: ${n.text}`)
    } finally { fs.chmodSync(ext, 0o700) }
  })
}
