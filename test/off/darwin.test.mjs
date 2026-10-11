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
import { legacyUndoHook } from '../../src/off/legacy.mjs'
import { flowEvents } from './fixtures/off-ctx.mjs'
import { macHome } from '../cli/fixtures/legacy-ctx.mjs'
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
    if (a === `print ${DOMAIN} ${LABEL}`) return loaded ? { status: 0, stdout: '…', stderr: '' } : { status: 1, stdout: '', stderr: `Could not find service "${LABEL}" in domain for system` }
    if (a === `bootout ${DOMAIN} ${LABEL}`) { loaded = false; return { status: 0, stdout: '', stderr: '' } }
    return { status: 1, stdout: '', stderr: `not in the fake: ${cmd}` }
  }
  return { run, calls, has: (re) => calls.some((c) => re.test(c)) }
}

const writePlist = (home) => { const f = plistOf(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Label</key><string>com.asight.collector</string></dict></plist>\n'); return f }

// the flip checklist ① (4.9 §4 末): a no-names `off` on darwin undoes the autostart through launchd — the agent booted out, the plist gone — and
// systemctl is never asked for anything. There is no daemon (no lock): the `unitIsUp` branch is what stops the (absent) daemon, so the arm's bootout
// is the only thing between KeepAlive and a daemon coming back.
test('the flip ① (4.9 §4): a no-names off on darwin boots the LaunchAgent out and removes the plist — launchd verbs only, never systemctl', async () => {
  const home = tmpDir('asight-off-darwin-')
  const plist = writePlist(home)
  const launchd = fakeLaunchd()
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: { platform: 'darwin', exec: launchd.run, procs: async () => [], sleep: async () => {} } })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  assert.ok(launchd.has(new RegExp(`^launchctl bootout ${DOMAIN} ${LABEL}$`)), 'the agent was booted out of the session')
  assert.ok(!launchd.has(/systemctl/), 'no systemd verb runs on darwin — the old step-5 ran `systemctl --user disable` unconditionally (the audit 2026-10-08 note)')
  assert.ok(!fs.existsSync(plist), 'the plist left ~/Library/LaunchAgents: launchd scans that directory at every login')
  assert.equal(receipt.autostart.disabled, true, JSON.stringify(receipt.autostart))
  assert.deepEqual(receipt.autostart.removed, [plist])
  assert.equal(receipt.ok, true)
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
  const bootoutAt = order.findIndex((x) => x === `launchctl bootout ${DOMAIN} ${LABEL}`)
  const firstSignalAt = order.findIndex((x) => /^kill /.test(x))
  assert.ok(bootoutAt >= 0 && firstSignalAt >= 0 && bootoutAt < firstSignalAt, `the bootout precedes the first signal (4.9 §4's order): ${JSON.stringify(order)}`)
  assert.ok(!launchd.has(/systemctl/), 'and still no systemd verb')
  assert.ok(fs.existsSync(plistOf(home)), 'a named off keeps the plist: the autostart is only a no-names off\'s to undo')
  assert.equal(receipt.autostart, undefined, 'no autostart row on a named off, as on Linux (the key is absent, not null)')
})

// the flip (4.9 §4), the leftovers arm: on a flipped Mac `asight off` also takes the OLD capture's remains out — through the same legacyUndo hook Linux
// has always used (orchestrate's step 7), which pre-flip never ran on darwin (the legacy off did that work instead) and whose hook hard-coded Linux's
// paths. The artifact that makes the platform matter: the old capture's own LaunchAgents, a darwin thing the Linux arm cannot even see.
test('the flip (4.9 §4): off on darwin takes the old capture\'s leftovers out too — the legacyUndo hook gets the platform, not Linux\'s paths', async () => {
  const world = macHome({ block: false, runtime: false, agents: ['com.asight.mitm', 'com.asight.monitor'], steer: false, ca: false })
  const home = world.home
  const mitmPlist = world.plist('com.asight.mitm')
  assert.ok(fs.existsSync(mitmPlist), 'the old capture\'s agent is there to be taken out')
  const launchd = fakeLaunchd()
  const legacy = []
  const run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    if (file === 'launchctl' && (args[0] === 'print' || args[0] === 'bootout') && cmd.includes(LABEL)) return launchd.run(file, args) // the collector's own agent
    if (file === 'launchctl') { legacy.push(cmd); return args[0] === 'list' ? { status: 113, stdout: '', stderr: 'Could not find service' } : { status: 0, stdout: '', stderr: '' } } // the old capture\'s questions: nothing is loaded
    if (file === 'security') { legacy.push(cmd); return { status: 44, stdout: '', stderr: 'could not be found in the keychain' } } // no old CA anywhere
    return { status: 1, stdout: '', stderr: `not in the fake: ${cmd}` }
  }
  // the mihomo sock is pinned to a socket nobody listens on: the route cannot be confirmed gone, so the MITM's own agent stays (V31: it is unloaded
  // only after the route is confirmed) and the receipt says so — exit 1, never a silent pass. What proves the platform pass-through is the monitor's
  // agent: the darwin arm took it out, where the hook's old hard-coded Linux paths would have left BOTH (that is what this cell is red against).
  const { receipt, exit } = await runOff({ home, env: { HOME: home, ASIGHT_MIHOMO_SOCK: path.join(home, 'no-such-mihomo.sock') }, deps: { platform: 'darwin', exec: run, procs: async () => [], sleep: async () => {}, legacyUndo: legacyUndoHook } }) // the hook the CLI injects (off/main.mjs); runOff alone defaults none — naming it is what this cell tests
  assert.equal(exit, 1, 'the route could not be confirmed, so this off is not done (the receipt names it)')
  assert.ok(receipt.problems.some((x) => /not confirmed gone/.test(x)), JSON.stringify(receipt.problems))
  assert.ok(!fs.existsSync(world.plist('com.asight.monitor')), 'the monitor\'s agent plist is GONE — the darwin arm of undoLegacy ran')
  assert.ok(fs.existsSync(mitmPlist), 'the MITM\'s agent stays until the route is confirmed gone (V31) — surfaced, never silently claimed done')
  assert.ok(receipt.removed.includes(world.plist('com.asight.monitor')), 'the receipt carries what the legacy undo did')
})
