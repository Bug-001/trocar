// test/helpers/os-stubs.mjs — a PATH for a test that runs the real bin/asight.mjs on a machine whose OS tools must not be touched (0.1 §3). The sandbox guard (src/off/exec.mjs) lets a
// spawn through only when the tool resolves into the temp dir, so the read-only questions `asight status` / `doctor` ask on a Mac (launchctl list / getenv, security find-certificate) are
// answered by stubs: nothing is loaded, no variable is set, no certificate is there. On Linux the network facts of `status` / `doctor` (1.6 §9.7) read `ss` and `ip`: stubs say nothing listens and the way out is a plain device. Returns the PATH string (the stub directory first); `calls` is the file the stubs append each call to.
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from './tmp.mjs'

export function osStubs() {
  const dir = tmpDir('asight-os-stubs-'), bin = path.join(dir, 'bin'), calls = path.join(dir, 'calls.log')
  fs.mkdirSync(bin)
  const sh = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`, { mode: 0o755 })
  sh('launchctl', 'case "$1" in list) echo "Could not find service" >&2; exit 113;; getenv) exit 0;; *) exit 1;; esac')
  sh('security', 'echo "could not be found" >&2; exit 44')
  sh('ps', 'exit 0') // the flip (4.9 §4): the NEW status on a Mac reads the process table too — an empty one is the nothing-running world
  sh('lsof', 'exit 0') // and the darwin network facts (4.9 §9's table): no listener, no default route's device, no utun — the plain world
  sh('route', 'exit 1')
  sh('ifconfig', 'exit 0')
  sh('scutil', 'exit 1')
  sh('ss', 'exit 0')
  sh('ip', 'case "$*" in *"route get"*) echo \'[{"dst":"1.1.1.1","dev":"eth0"}]\';; *"link show"*) echo \'[{"ifname":"eth0","linkinfo":{}}]\';; esac; exit 0')
  return { path: `${bin}${path.delimiter}${process.env.PATH || ''}`, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []) }
}
