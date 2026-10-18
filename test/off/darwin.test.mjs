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

// the flip checklist ① (4.9 §4 末) under D61 + D62 ⑥: a no-names `off` on darwin asks launchd for NOTHING. There is no daemon here (no lock), and a
// daemon KeepAlive brings back is now the wanted end state — doors shut, nothing on any agent's path — so there is nothing to boot out, nothing to
// disable, and systemctl is never asked for anything either.
test('D61 + D62 ⑥: a no-names off on darwin with no daemon asks launchd for nothing and keeps the plist enabled — never a bootout, never a disable, never systemctl', async () => {
  const home = tmpDir('asight-off-darwin-')
  const plist = writePlist(home)
  const launchd = fakeLaunchd()
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: { platform: 'darwin', exec: launchd.run, procs: async () => [], sleep: async () => {} } })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  assert.ok(!launchd.has(/bootout/), `nothing is booted out: a daemon launchd brings back with no door open is the end state off wants (D62 ⑥): ${JSON.stringify(launchd.calls)}`)
  assert.ok(!launchd.has(/systemctl/), 'no systemd verb runs on darwin')
  assert.ok(fs.existsSync(plist), 'the plist stays (an install item, D61): the next login starts the daemon again, with no doors open')
  // D61: off never touches the autostart — no disable, and no autostart row in the receipt
  assert.ok(!launchd.has(/^launchctl disable /), `no off disables the LaunchAgent (D61): ${JSON.stringify(launchd.calls)}`)
  assert.equal(receipt.autostart, undefined, 'no autostart row: off has nothing to say about it (D61)')
  assert.equal(receipt.ok, true)
})

// Red before T19: a daemon that answers after a no-names off is never booted out — the bootout took it down mid-stream while the receipt said
// clean. Under D62 ⑥ it is not even asked to exit: it closes its doors and goes on idling, so the LaunchAgent is left exactly as `install` registered
// it (D61) and the next `on` asks the daemon that is there.
test('with D61 + D62 ⑥: a no-names off with an answering daemon touches launchd not at all, and asks for no exit', async () => {
  const home = tmpDir('asight-off-darwin-')
  const plist = writePlist(home)
  const launchd = fakeLaunchd()
  const asked = []
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: {
    platform: 'darwin', exec: launchd.run, procs: async () => [], sleep: async () => {}, socketPath: '/x/collector.sock',
    daemonState: async () => ({ state: 'running', socket: '/t/asight-0123456789abcdef.sock' }),
    request: async (q) => { asked.push(q.body); return { actual: 'off', confirmed: true, pid: 4242, relayed: { closing: 1, waiting: 0, cut: 0 } } },
  } })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  assert.equal(asked[0].exit, undefined, `proxy mode: the doors are the whole of it, no exit is asked for (D62 ⑥): ${JSON.stringify(asked[0])}`)
  assert.ok(!launchd.has(/bootout/), `no bootout while the daemon drains: ${JSON.stringify(launchd.calls)}`)
  assert.ok(!launchd.has(/^launchctl disable /), `no off disables the LaunchAgent (D61): ${JSON.stringify(launchd.calls)}`)
  assert.ok(fs.existsSync(plist))
  assert.deepEqual([receipt.daemon.state, receipt.daemon.exits_after], ['running', undefined], 'the receipt says it keeps running, with nothing to wait for')
  assert.equal(receipt.autostart, undefined, 'no autostart row (D61)')
})

// the failure half (D38): off boots the loaded agent out when it has to STOP a daemon that does not answer (4.9 §4's order — a stopped daemon under a
// loaded agent is pulled right back). A bootout launchctl refuses is said: the off is not clean (exit 1), the receipt names the way out, and the
// failure record carries the closed set's stop-failed. There is no autostart row to put it in (D61).
test('the flip ① (4.9 §4) with D61: stopping a daemon that does not answer, a bootout launchctl refuses is not a silent pass — exit 1, the receipt names the way out, the record says stop-failed', async () => {
  const home = tmpDir('asight-off-darwin-')
  const dir = path.join(home, '.asight', 'collector')
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true })
  writePlist(home)
  const calls = []
  const run = (file, args) => { const cmd = [file, ...args].join(' '); calls.push(cmd); return /print /.test(cmd) ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'Boot-out failed: the operation was cancelled' } } // present, but the bootout refuses
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: { platform: 'darwin', exec: run, procs: async () => [], sleep: async () => {}, socketPath: '/x/collector.sock', daemonState: async () => ({ state: 'unresponsive', reason: 'does not answer', socket: '/x/collector.sock' }), alive: () => true } })
  assert.equal(exit, 1, 'a not-done off')
  assert.equal(receipt.autostart, undefined, 'off has no autostart row to fail in (D61)')
  assert.ok(receipt.problems.some((p) => /bootout/i.test(p)), `the receipt says the bootout failed: ${JSON.stringify(receipt.problems)}`)
  const rec = flowEvents(dir).find((e) => e.event === 'failure' && e.code === 'stop-failed')
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
  // the lock as a darwin daemon writes it (psIdentity's lstart + kern.boottime seconds; the socket in $TMPDIR, 4.9 §7)
  fs.writeFileSync(path.join(dir, 'lock'), `${JSON.stringify({ pid: 4242, start_time: 'Wed Oct 7 04:27:00 2026', boot_id: '1760000000', helper_pid: 4243, socket: '/t/asight-0123456789abcdef.sock', engine_port: 47011 })}\n`)
  const order = []
  const launchd = fakeLaunchd(order)
  const signals = []
  const live = new Set([4242])
  const { receipt, exit } = await runOff({
    home, env: { HOME: home }, ids: ['claude-code'],
    deps: {
      platform: 'darwin', exec: launchd.run, procs: async () => [],
      alive: (pid) => live.has(pid), identity: (pid) => (pid === 4242 ? { start_time: 'Wed Oct 7 04:27:00 2026', boot_id: '1760000000' } : { start_time: null, boot_id: null }),
      isHelper: (pid) => pid === 4243, kill: (pid, sig) => { order.push(`kill ${pid} ${sig}`); signals.push([pid, sig]); live.delete(pid) },
      sleep: async () => {},
    },
  })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  const bootoutAt = order.findIndex((x) => x === `launchctl bootout ${DOMAIN}/${LABEL}`)
  assert.ok(!launchd.has(/^launchctl disable /), `a named off never disables the autostart, even when it stops a stuck daemon (1.6 §1.4): ${JSON.stringify(order)}`)
  const firstSignalAt = order.findIndex((x) => /^kill /.test(x))
  assert.ok(bootoutAt >= 0 && firstSignalAt >= 0 && bootoutAt < firstSignalAt, `the bootout precedes the first signal (4.9 §4's order): ${JSON.stringify(order)}`)
  assert.ok(!launchd.has(/systemctl/), 'and still no systemd verb')
  assert.ok(fs.existsSync(plistOf(home)), 'a named off keeps the plist: the autostart is only a no-names off\'s to undo')
  assert.equal(receipt.autostart, undefined, 'no autostart row on a named off, as on Linux (the key is absent, not null)')
})

// the leftovers arm (4.9 §4) went with the old capture (D39⑥ executed 2026-10-11): `asight off` no longer takes the old capture's
// remains out — what it left on a machine is cleaned by hand (README); the new off undoes the collector's own entries only.
