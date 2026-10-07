// test/helpers/uninstall.mjs — the old `uninstallCollector({ home, env, scan, stop, roots, purgeData })` call and its report over `runUninstall` (src/cli/uninstall.mjs).
// The tests of what uninstall restores, keeps and says (4.6 §撤一个文件的规则, 撤销顺序) were written against that call; they now run through the one uninstall the product
// has (1.6 §1.1), with the world replaced the way a test does (0.1 §3): `stop` stands in for the process manager (the daemon is "not there" and `stop()` is told to stop
// it), the OS tools go to a recording runner that is handed back as `.exec`, and the report keeps the old shape (`daemon`, `entries`, `removed`, `residue`, `kept_bundles`,
// `still_trusting`, `kept_captures`, `notes`, `left`, `dropped_backups`) built from the receipt. What the new uninstall does differently (a manifest it cannot read, a lock
// it cannot read: exit 1 with the reasons, not a throw) has its own tests in test/cli/uninstall.test.mjs. Exports only.
import tls from 'node:tls'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { recordingExec } from '../cli/fixtures/on-ctx.mjs'

/** `stop` (optional): `async () => 'none' | 'stopped'`, called when uninstall stops the daemon. `deps`: more of the world (`exec`, `fs`, `request`, `daemonState`, …). */
export async function uninstallCollector({ home, env = {}, purgeData = false, scan = async () => [], stop = null, roots = null, deps = {}, yes = true } = {}) {
  const exec = deps.exec ? { run: deps.exec } : recordingExec()
  let how = 'none'
  const d = {
    exec: exec.run, platform: 'linux', procs: scan, roots: roots || { node: [...tls.rootCertificates], osText: '' }, sleep: async () => {}, drainMs: 0,
    ...(stop ? { daemonState: async () => ({ state: 'none', lock: null }), stopDaemon: async () => { how = await stop(); return { stopped: true, how: how === 'stopped' ? 'signal' : 'none', pid: null, signals: how === 'stopped' ? ['SIGTERM'] : [], helper_pid: null } } } : {}),
    ...deps,
  }
  const { receipt } = await runUninstall({ home, env, purgeData, yes, deps: d })
  return {
    daemon: stop ? how : receipt.daemon && receipt.daemon.state === 'stopped' ? 'stopped' : 'none',
    entries: receipt.entries, removed: receipt.removed, residue: receipt.residue.map((x) => x.path), kept_bundles: receipt.kept_bundles,
    still_trusting: receipt.still_trusting.map(({ pid, harness, until }) => ({ pid, agent: harness, until })), kept_captures: !purgeData,
    notes: receipt.notes, left: receipt.left.map(({ path, harness, result }) => ({ path, harness, result })), dropped_backups: receipt.dropped_backups,
    receipt, exec,
  }
}
