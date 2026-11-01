// test/cli/fixtures/legacy-ctx.mjs — launchd, the login environment and the keychain of a Mac as one fake runner, for a test of a command that asks them.
// Nothing here reaches the machine the tests run on (0.1 §3): every OS tool goes to the fake runner.
import path from 'node:path'

const LABELS = ['com.trocar.mitm', 'com.trocar.monitor', 'com.trocar.env']

/**
 * launchd, the login environment and the keychain as one fake runner (`run` has the shape of spawnSync's answer). Every call is recorded in `calls` (and in `order`, when given).
 * `list <label>` is 0 for a loaded label (with a PID when it has one) and 113 otherwise; `unload <plist>` takes the label out (after `onUnload(label)`, which a test hangs the MITM's SIGTERM on); `load <plist>` of a label in `failLoad` is refused (exit 5); `getenv` answers
 * `env`; `security find-certificate` is 0 while `keychain` is true and 44 after the delete.
 */
export function fakeMac({ loaded = LABELS, pids = { 'com.trocar.mitm': 4242 }, env = {}, keychain = true, onUnload = () => {}, order = [], failUnload = [], failLoad = [] } = {}) {
  const calls = []
  const state = { loaded: new Set(loaded), env: { ...env }, keychain }
  const run = (file, args) => {
    // `ps -o lstart= -p <pid>`: the identity the op lock asks for on a Mac (src/off/proc.mjs identityFor). Not an action of the product: it is neither recorded nor ordered, so a test that
    // lists the calls of a command lists what the command did to the machine; the answer is one fixed start time, the same for every pid
    if (file === 'ps' && args[0] === '-o' && args[1] === 'lstart=') return { status: 0, stdout: 'Wed Oct  7 04:27:00 2026\n', stderr: '' }
    const cmd = [file, ...args].join(' ')
    calls.push(cmd); order.push(cmd)
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
    if (file === 'launchctl') {
      const [sub, a] = args
      if (sub === 'list') return state.loaded.has(a) ? ok(`{\n\t"Label" = "${a}";\n${pids[a] ? `\t"PID" = ${pids[a]};\n` : ''}};`) : { status: 113, stdout: '', stderr: `Could not find service "${a}" in domain for port` }
      if (sub === 'unload') {
        const label = path.basename(a, '.plist')
        if (failUnload.includes(label)) return { status: 5, stdout: '', stderr: 'Unload failed: 5: Input/output error' }
        onUnload(label); state.loaded.delete(label); return ok()
      }
      if (sub === 'remove') { state.loaded.delete(a); return ok() }
      if (sub === 'getenv') return ok(state.env[a] || '')
      if (sub === 'unsetenv') { delete state.env[a]; return ok() }
      if (sub === 'load') { const label = path.basename(a, '.plist'); if (failLoad.includes(label)) return { status: 5, stdout: '', stderr: 'Load failed: 5: Input/output error' }; state.loaded.add(label); return ok() }
      if (sub === 'setenv') { state.env[a] = args[2]; return ok() }
    }
    if (file === 'security') {
      if (args[0] === 'find-certificate') return state.keychain ? ok('keychain: ...') : { status: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' }
      if (args[0] === 'delete-certificate') { if (!state.keychain) return { status: 44, stdout: '', stderr: 'could not be found' }; state.keychain = false; return ok() }
      if (args[0] === 'add-certificates') { state.keychain = true; return ok() }
    }
    return { status: 1, stdout: '', stderr: `fakeMac: no answer for ${cmd}` }
  }
  return { run, calls, state, has: (re) => calls.some((c) => re.test(c)), mutating: () => calls.filter((c) => /^launchctl (unload|unsetenv|remove|load|setenv)|^security (delete|add)/.test(c)) }
}
