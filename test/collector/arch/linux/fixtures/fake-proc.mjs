// test/collector/arch/linux/fixtures/fake-proc.mjs — a synthetic /proc tree for unit tests (exports only).
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../../helpers/tmp.mjs'

export function fakeProc() {
  const root = tmpDir('trocar-proc-')
  const btime = 1_700_000_000
  fs.writeFileSync(path.join(root, 'stat'), `cpu 1 2 3\nbtime ${btime}\nprocesses 9\n`)
  function add(pid, { ppid = 1, uid = 1000, exe = '/bin/true', argv = [exe], env = null, cwd = '/', startTicks = 0, comm = path.basename(exe) } = {}) {
    const d = path.join(root, String(pid))
    fs.mkdirSync(d, { recursive: true })
    fs.symlinkSync(exe, path.join(d, 'exe'))
    fs.symlinkSync(cwd, path.join(d, 'cwd'))
    fs.writeFileSync(path.join(d, 'cmdline'), argv.join('\0') + '\0')
    if (env) fs.writeFileSync(path.join(d, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0')
    fs.writeFileSync(path.join(d, 'status'), `Name:\t${comm}\nPPid:\t${ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`)
    fs.writeFileSync(path.join(d, 'stat'), `${pid} (${comm}) S ${ppid} ${'0 '.repeat(17)}${startTicks} 0 0\n`)
  }
  return { root, btime, add, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
