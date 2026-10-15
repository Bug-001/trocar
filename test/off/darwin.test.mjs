// test/off/darwin.test.mjs — the darwin arm of `asight off` / `asight uninstall`'s orchestration (RFC 4.9 §4; the flip checklist's item ①): the autostart
// is a LaunchAgent, not a systemd unit, so `off` must never reach for systemctl on darwin — the agent is booted out of the session (launchd's KeepAlive
// really does pull a stopped daemon back, which is why the bootout comes BEFORE any signal) and the plist leaves ~/Library/LaunchAgents (launchd scans
// that directory at every login: a file left there brings the agent back at the next one, D39). The undo itself is src/off/darwin.mjs undoAutostart
// (already tested there, against the arch module's own verbs); what this file pins is the ORCHESTRATION: step 5 of a no-names off runs it, a named off
// stops a stuck daemon launchd-first and keeps the plist (the temporary stop `systemctl --user stop` is on Linux), and the systemd-shaped words
// (wayOut, the Restart=on-failure branch) are darwin's. Nothing here runs a real OS tool: launchctl is a stateful fake (a print says present until a
// bootout succeeds), every signal a recording kill, HOME a temp directory.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOff } from '../../src/off/orchestrate.mjs'
import { flowEvents } from './fixtures/off-ctx.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const UID = process.getuid()
const DOMAIN = `gui/${UID}`
const LABEL = 'com.asight.collector'
const plistOf = (home) => path.join(home, 'Library', 'LaunchAgents', 'com.asight.collector.plist')

/** launchctl as a stateful fake: the agent is loaded until a bootout of it succeeds; every call is recorded in `calls` (and pushed to `order`, a log a
 *  test shares with its fake kill so cross-recorder order is assertable — the bootout MUST precede the first signal, 4.9 §4). */
function fakeLaunchd(order = null) {
  const calls = []
  let loaded = true
  const run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    calls.push(cmd)
    if (order) order.push(cmd)
    if (file !== 'launchctl') return { status: 1, stdout: '', stderr: `not launchctl: ${cmd}` }
    const a = args.join(' ')
    if (a === `print ${DOMAIN}/${LABEL}`) return loaded ? { status: 0, stdout: '…', stderr: '' } : { status: 1, stdout: '', stderr: `Could not find service "${LABEL}" in domain for system` }
    if (a === `disable ${DOMAIN}/${LABEL}`) return { status: 0, stdout: '', stderr: '' } // the job stays loaded; launchd only stops loading it
    if (a === `bootout ${DOMAIN}/${LABEL}`) { loaded = false; return { status: 0, stdout: '', stderr: '' } } // the slash form: the two-argument bootout answers I/O error 5 on macOS 26 (the rule darwin.mjs's launchctl carries)
    return { status: 1, stdout: '', stderr: `not in the fake: ${cmd}` }
  }
  return { run, calls, has: (re) => calls.some((c) => re.test(c)) }
}

const writePlist = (home) => { const f = plistOf(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Label</key><string>com.asight.collector</string></dict></plist>\n'); return f }

// the flip checklist ① (4.9 §4 末): a no-names `off` on darwin undoes the autostart through launchd — the agent booted out, the plist gone — and
// systemctl is never asked for anything. There is no daemon (no lock): the `unitIsUp` branch is what stops the (absent) daemon, so the arm's bootout
// is the only thing between KeepAlive and a daemon coming back.
test('the flip ① (4.9 §4) with a no-names off on darwin with no daemon stops the loaded agent (disable, then bootout: nothing drains) and keeps the plist — launchd verbs only, never systemctl', async () => {
  const home = tmpDir('asight-off-darwin-')
  const plist = writePlist(home)
  const launchd = fakeLaunchd()
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: { platform: 'darwin', exec: launchd.run, procs: async () => [], sleep: async () => {} } })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  const at = (re) => launchd.calls.findIndex((c) => re.test(c))
  assert.ok(at(/^launchctl disable /) >= 0 && at(/^launchctl disable /) < at(/^launchctl bootout /), `disable precedes the bootout: ${JSON.stringify(launchd.calls)}`)
  assert.ok(launchd.has(new RegExp(`^launchctl bootout ${DOMAIN}/${LABEL}$`)), 'no daemon runs, so the loaded agent is booted out (the slash form)')
  assert.ok(!launchd.has(/systemctl/), 'no systemd verb runs on darwin')
  assert.ok(fs.existsSync(plist), 'the plist stays (an install item): the disabled job is not loaded at a login')
  assert.equal(receipt.autostart.disabled, true, JSON.stringify(receipt.autostart))
  assert.deepEqual(receipt.autostart.removed, [])
  assert.equal(receipt.ok, true)
})

// a daemon that answers and is draining after a no-names off is never booted out — the bootout took the daemon down mid-stream
// while the receipt said clean. off disables the job; the daemon exits itself once drained, and KeepAlive {SuccessfulExit:false} does not relaunch it.
test('a no-names off with a draining daemon runs launchctl disable and never a bootout before the drain', async () => {
  const home = tmpDir('asight-off-darwin-')
  const plist = writePlist(home)
  const launchd = fakeLaunchd()
  const asked = []
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: {
    platform: 'darwin', exec: launchd.run, procs: async () => [], sleep: async () => {}, socketPath: '/x/collector.sock',
    daemonState: async () => ({ state: 'running', socket: '/x/collector.sock' }),
    request: async (q) => { asked.push(q.body); return { actual: 'off', confirmed: true, pid: 4242, relayed: { closing: 1, waiting: 0, cut: 0 } } },
  } })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  assert.equal(asked[0].exit, true, 'the daemon is asked to exit once drained')
  assert.ok(!launchd.has(/bootout/), `no bootout while the daemon drains: ${JSON.stringify(launchd.calls)}`)
  assert.ok(launchd.has(new RegExp(`^launchctl disable ${DOMAIN}/${LABEL}$`)), 'disable is what keeps launchd from loading it again')
  assert.ok(fs.existsSync(plist))
  assert.equal(receipt.daemon.state, 'draining')
  assert.deepEqual(receipt.autostart, { disabled: true, removed: [] })
})

// the failure half (D38): a bootout that launchctl refuses is said — the autostart row is NOT disabled, the failure record carries the closed set's
// unit-not-disabled, and the receipt names the way out.
test('the flip ① (4.9 §4): a bootout launchctl refuses is not a silent pass — the row says not disabled, the record says unit-not-disabled', async () => {
  const home = tmpDir('asight-off-darwin-')
  const dir = path.join(home, '.asight', 'collector')
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true })
  writePlist(home)
  const calls = []
  const run = (file, args) => { const cmd = [file, ...args].join(' '); calls.push(cmd); return /print /.test(cmd) ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'Boot-out failed: the operation was cancelled' } } // present, but the bootout refuses
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: { platform: 'darwin', exec: run, procs: async () => [], sleep: async () => {} } })
  assert.equal(exit, 1, 'a not-done off')
  assert.equal(receipt.autostart.disabled, false)
  assert.match(receipt.autostart.error, /boot-?out/i)
  const rec = flowEvents(dir).find((e) => e.event === 'failure' && e.code === 'unit-not-disabled')
  assert.ok(rec, `the failure record exists in the closed set: ${JSON.stringify(flowEvents(dir))}`)
  assert.doesNotThrow(() => checkRecord(rec))
})

// the KeepAlive order (4.9 §4: 先 bootout 再停进程): a daemon that must be STOPPED is preceded by the bootout — a stopped daemon under a loaded agent
// would be pulled right back. A NAMED off: the plist STAYS (the same temporary stop `systemctl --user stop` is on Linux — only a no-names off undoes
// the autostart, step 5), the next login brings the job back.
test('the flip ① (4.9 §4): a stuck daemon on darwin is stopped launchd-first — the bootout precedes the first signal, and a named off keeps the plist', async () => {
  const home = tmpDir('asight-off-darwin-')
  const dir = path.join(home, '.asight', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  writePlist(home)
  fs.writeFileSync(path.join(dir, 'lock'), `${JSON.stringify({ pid: 4242, start_time: '111', boot_id: 'boot-1', helper_pid: 4243, socket: '/x/collector.sock', engine_port: 47011 })}\n`)
  const order = []
  const launchd = fakeLaunchd(order)
  const signals = []
  const live = new Set([4242])
  const { receipt, exit } = await runOff({
    home, env: { HOME: home }, ids: ['claude-code'],
    deps: {
      platform: 'darwin', exec: launchd.run, procs: async () => [],
      alive: (pid) => live.has(pid), identity: (pid) => (pid === 4242 ? { start_time: '111', boot_id: 'boot-1' } : { start_time: null, boot_id: null }),
      isHelper: (pid) => pid === 4243, kill: (pid, sig) => { order.push(`kill ${pid} ${sig}`); signals.push([pid, sig]); live.delete(pid) },
      sleep: async () => {},
    },
  })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  const bootoutAt = order.findIndex((x) => x === `launchctl bootout ${DOMAIN}/${LABEL}`)
  assert.ok(order.indexOf(`launchctl disable ${DOMAIN}/${LABEL}`) >= 0 && order.indexOf(`launchctl disable ${DOMAIN}/${LABEL}`) < bootoutAt, 'disable first, so launchd loads it no more')
  const firstSignalAt = order.findIndex((x) => /^kill /.test(x))
  assert.ok(bootoutAt >= 0 && firstSignalAt >= 0 && bootoutAt < firstSignalAt, `the bootout precedes the first signal (4.9 §4's order): ${JSON.stringify(order)}`)
  assert.ok(!launchd.has(/systemctl/), 'and still no systemd verb')
  assert.ok(fs.existsSync(plistOf(home)), 'a named off keeps the plist: the autostart is only a no-names off\'s to undo')
  assert.equal(receipt.autostart, undefined, 'no autostart row on a named off, as on Linux (the key is absent, not null)')
})

// the leftovers arm (4.9 §4) went with the old capture (D39⑥ executed 2026-10-11): `asight off` no longer takes the old capture's
// remains out — what it left on a machine is cleaned by hand (README); the new off undoes the collector's own entries only.
