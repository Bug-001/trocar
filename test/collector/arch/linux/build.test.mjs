// test/collector/arch/linux/build.test.mjs — the helper's build picks a bpftool that runs (4.6 §Linux 机制): the first candidate whose
// `version` succeeds, so a wrapper that refuses this kernel (Ubuntu's /usr/sbin/bpftool on a kernel it has no linux-tools package for)
// is passed over for a build that works. Real make on a copy of the Makefile; the candidates are stubs in the temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../../helpers/tmp.mjs'

const MAKEFILE = fileURLToPath(new URL('../../../../src/collector/arch/linux/Makefile', import.meta.url))
const hasMake = spawnSync('make', ['--version'], { stdio: 'ignore' }).status === 0

/** A bpftool stub: `version` exits 0 unless `refuses`; `btf dump …` prints a C comment with `name` (and then fails when `dumpFails`). */
function stub(dir, name, { refuses = false, dumpFails = false } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'bpftool')
  const btf = dumpFails ? `echo '/* ${name} */'; exit 1` : `echo '/* ${name} */'`
  fs.writeFileSync(p, `#!/bin/sh\ncase "$1" in version) exit ${refuses ? 1 : 0};; btf) ${btf};; esac\n`, { mode: 0o755 })
  return p
}

function build(candidates) {
  const dir = tmpDir('trocar-linux-build-')
  fs.mkdirSync(path.join(dir, 'bpf'))
  fs.copyFileSync(MAKEFILE, path.join(dir, 'Makefile'))
  const env = { ...process.env }
  delete env.BPFTOOL // an operator's BPFTOOL wins over the search
  const r = spawnSync('make', ['-s', '-C', dir, `BPFTOOL_TRY=${candidates.join(' ')}`, 'bpf/vmlinux.h'], { encoding: 'utf8', env })
  const out = path.join(dir, 'bpf', 'vmlinux.h')
  return { code: r.status, stderr: r.stderr, header: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null }
}

test('build: the first bpftool that runs is the one used; a refusing wrapper before it is passed over', { skip: !hasMake && 'no make here' }, () => {
  const t = tmpDir('trocar-bpftool-')
  const r = build([stub(path.join(t, 'wrapper'), 'wrapper', { refuses: true }), stub(path.join(t, 'tools'), 'tools')])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.header.trim(), '/* tools */')
})

test('build: with no bpftool that runs, the build stops naming bpftool and writes no header', { skip: !hasMake && 'no make here' }, () => {
  const t = tmpDir('trocar-bpftool-')
  const r = build([stub(path.join(t, 'wrapper'), 'wrapper', { refuses: true })])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /bpftool/)
  assert.equal(r.header, null)
})

test('build: a dump that fails half way leaves no header, so the next make tries again instead of compiling a broken one', { skip: !hasMake && 'no make here' }, () => {
  const t = tmpDir('trocar-bpftool-')
  const r = build([stub(path.join(t, 'tools'), 'tools', { dumpFails: true })])
  assert.notEqual(r.code, 0)
  assert.equal(r.header, null)
})
