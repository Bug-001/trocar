// on.mjs — `asight on [harness…] [--dry-run] [--yes] [--no-autostart|--no-unit] [--json]` (RFC 1.6 §1.1, §1.6, §2, R4–R7): the front end of
// turnOn (src/collector/install.mjs). It parses the arguments, builds what turnOn needs from the platform (the descriptors, the process table,
// the autostart unit, the control socket), decides how a confirmation is asked, and prints the plan and the receipt. Everything the world gives is a
// `deps` entry a test replaces (0.1 §3): `parts` (the descriptors, `scan`, `match`, the arch), `exec` (the runner of OS tools: spawnSync-shaped),
// `request` (the control socket), `helperState`, `linger` / `lingerRead`, `now`, `freePort`, `sleep`, `roots`, `user`, `getuid`, `fs`, `script`, and `legacyOn` — the
// replacement of what a platform without the new collector (macOS, Windows: 1.6 §4) runs instead: legacyOnCli, src/capture/legacy-on.mjs.
// Exit codes (R4): 0 done · 1 not done or a problem · 2 usage error / not in a terminal without --yes (nothing touched).
import os from 'node:os'
import nodeFs from 'node:fs'
import path from 'node:path'
import { resolveHarnesses } from './harness-names.mjs'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, confirm as ask } from '../off/io.mjs'
import { formatOnReceipt, formatPlan } from './receipt.mjs'
import { probeNetenv } from '../netenv/index.mjs'
import { renderCompact } from '../netenv/topology-text.mjs'
import { hasNewCollector } from '../off/legacy.mjs'
import { legacyOnCli } from '../capture/legacy-on.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { prepareAdoption, editedFields, recordAdoption } from './on-adopt.mjs'

const USAGE = 'usage: asight on [harness…] [--dry-run] [--yes] [--no-autostart | --no-unit] [--json]'
const FLAGS = new Set(['--dry-run', '--yes', '--no-autostart', '--no-unit', '--json'])
const PROXY_HINT = 'D39 之前的 `asight on --proxy` 现在是 `asight monitor on --no-autostart`(旧 CC-CLI steer 仍在 monitor 下;新的 on 不做它,它做不到 off 保证,1.6 §4)'
const chainText = (t) => renderCompact(t).join(' ; ')
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)

/** → the exit code. `argv` is what follows `on`. `io` = { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo). */
export async function runOnCli(argv, { io, env = process.env, home = os.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set(), names = []
  for (const a of argv) {
    if (a === '--proxy' || a.startsWith('--proxy=')) { io.err(`asight on: ${PROXY_HINT}`); return EXIT.usage }
    if (a.startsWith('-')) {
      if (!FLAGS.has(a)) { io.err(`asight on: unknown option ${a}\n${USAGE}`); return EXIT.usage }
      flags.add(a)
    } else if (!(a.startsWith('http://') || a.startsWith('https://'))) names.push(a)
    else { io.err(`asight on: ${PROXY_HINT}`); return EXIT.usage }
  }
  if (flags.has('--no-autostart') && flags.has('--no-unit')) { io.err(`asight on: --no-autostart and --no-unit exclude each other (the first writes the unit and starts it once, the second writes none)\n${USAGE}`); return EXIT.usage }
  const named = resolveHarnesses(names)
  if (!named.ok) { io.err(`asight on: unknown harness ${named.unknown.join(', ')}; the names are: ${named.known.join(', ')}`); return EXIT.usage }
  const json = flags.has('--json')
  const say = json ? io.err : io.out // stdout holds the one JSON in --json mode (R5); warnings and the plan go to stderr
  if (!hasNewCollector(platform)) { // 1.6 §4: no new collector here: `on` drives the old capture (src/capture/legacy-on.mjs)
    return (deps.legacyOn || legacyOnCli)(argv, { io, env, home, platform, deps, ids: named.ids })
  }
  if ((deps.getuid || processUid)() === 0) { io.err('asight on: 用你自己的账号跑,不要用 root / sudo(D36;只有 `sudo asight setup-helper` 要 root)'); return EXIT.incomplete }
  try {
    const parts = deps.parts || await (await (deps.daemon || import('../collector/daemon.mjs'))).loadParts({ env })
    const install = deps.install || await import('../collector/install.mjs')
    const script = deps.script || process.argv[1]
    const unit = flags.has('--no-unit') || !parts.arch || !parts.arch.unit || !parts.arch.unit.userUnit ? null : parts.arch.unit.userUnit({ home, node: process.execPath, script, run: deps.exec || null, env })
    const helperState = deps.helperState || (parts.arch && parts.arch.install && parts.arch.install.helperState ? () => parts.arch.install.helperState() : null)
    const autostart = !flags.has('--no-autostart')
    const yes = flags.has('--yes')
    const confirm = async () => {
      if (yes) return true
      if (!isInteractive(io)) return null // not a terminal: the plan is all we print (R6)
      return ask({ ...io, prompt: json ? io.stderr : io.stdout }, 'asight 将按上面的清单写或改这些文件。继续?')
    }
    // the machine's VPN / proxy software (§6): looked at once, named in the plan and in the receipt; asight changes none of it. The cache ~/.asight/netenv.json is `status`'s and `doctor`'s to write, not `on`'s:
    // the receipt lists exactly the files `on` wrote (V3), and a second `on` writes nothing (R9)
    const netenv = await probeNetenv({ home, platform, env, deps })
    const adoption = await prepareAdoption({ home, env, platform, deps, parts, netenv, now: deps.now ? () => deps.now().getTime() : Date.now }) // §9.5: the proxy each agent already uses, and the chain once asight is on
    const routing = deps.routing || null
    // The arch's read-only preflight (4.8 §8 ⑥, W27 ⑥, W74; Windows: the kernel line and the Smart App Control line), run BEFORE turnOn so a refusal
    // stops `on` before its first write — a settled precondition with nothing to roll back. The Linux arch has no `prepare` and nothing here changes.
    // The refusal's event and receipt are on's to write; with no collector directory yet (nothing installed) the receipt is the record (4.6 §记录).
    const fs = deps.fs || nodeFs
    const archPrepare = parts.arch && typeof parts.arch.prepare === 'function' ? parts.arch.prepare : null
    const prep = archPrepare ? await archPrepare({ env }) : null
    if (prep && prep.refuse) {
      const rf = prep.refuse
      const line = `${rf.reason}${Array.isArray(rf.commands) && rf.commands.length ? `。重装: ${rf.commands.join(' 或 ')}` : ''}`
      if (!flags.has('--dry-run')) {
        const receipt = { ...newReceipt('on'), ok: false, harnesses: named.ids, notes: [line] }
        const cdir = path.join(home, '.asight', 'collector')
        try { if (fs.existsSync(cdir)) appendEvent(cdir, { event: 'failure', where: 'forwarder', code: rf.code, ...(rf.of ? { of: rf.of } : {}), reason: line }) } catch { /* the receipt is the record then (R11) */ }
        if (json) io.out(JSON.stringify(receipt, null, 2))
        else io.out(formatOnReceipt(receipt, { tense: 'past', home }))
        return EXIT.incomplete
      }
      // a dry run prints the plan and exits 0; the stop a real run would meet is in the receipt (R6, V7)
      prep.blocked = line
    }
    let { receipt, exit } = await install.turnOn({
      home, env, ids: named.ids, osName: parts.os, harnesses: parts.harnesses, scan: parts.scan, match: parts.match, osRootsFile: parts.osRootsFile || null,
      roots: deps.roots || null, unit, autostart, freePort: deps.freePort, dryRun: flags.has('--dry-run'), confirm,
      networkEdited: async (targets) => editedFields({ adoption, routing, targets, home, env, fs: deps.fs }),
      onPlan: (plan) => say([formatPlan({ ...plan, adopted: adoption && !adoption.error ? Object.entries(adoption.chains(plan.targets)).filter(([h]) => plan.targets.includes(h)).map(([h, t]) => ({ harness: h, chain: chainText(t) })) : [] }, { home, autostart, netenv }), ...(prep && prep.notes && prep.notes.length ? ['', ...prep.notes] : [])].join('\n')),
      request: deps.request, now: deps.now, getuid: deps.getuid, helperState, linger: deps.linger || parts.linger || null, lingerRead: deps.lingerRead || (deps.linger ? null : parts.lingerRead || null), sleep: deps.sleep, user: deps.user, fs: deps.fs,
    })
    receipt.netenv = netenv.error ? { error: netenv.error } : netenv.result
    if (prep && prep.notes && prep.notes.length) receipt.notes.push(...prep.notes) // the preflight's lines ride along (the plan showed them above)
    if (prep && prep.blocked) { receipt.blocked = prep.blocked; receipt.notes.push(`${prep.blocked} (a real asight on stops there)`) }
    if (adoption && adoption.error) receipt.notes.push(adoption.error)
    else if (adoption && receipt.harnesses && receipt.harnesses.length && receipt.ok !== false && !receipt.dry_run && !receipt.planned && !receipt.declined) {
      const rec = await recordAdoption({ adoption, routing, targets: receipt.harnesses, home, env, now: deps.now ? () => deps.now().getTime() : Date.now, netenv, fs: deps.fs })
      receipt.adopted = rec.adopted
      if (rec.wrote) receipt.created.push(rec.wrote)
      for (const h of rec.failed) receipt.ok = false
      receipt.notes.push(...rec.notes)
      if (rec.failed.length) exit = EXIT.incomplete
    } else if (adoption && receipt.dry_run) receipt.adopted = Object.fromEntries(Object.entries(adoption.chains(receipt.harnesses || [])).filter(([h]) => (receipt.harnesses || []).includes(h)).map(([h, t]) => [h, { chain: chainText(t), dry_run: true }]))
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else if (receipt.planned) for (const n of receipt.notes) io.err(n) // the plan was printed; what is left to say is why nothing was done (R6)
    else io.out(formatOnReceipt(receipt, { tense: receipt.dry_run ? 'future' : 'past', home }))
    return exit
  } catch (e) {
    const message = String((e && e.message) || e)
    if (json) io.out(JSON.stringify({ ...newReceipt('on'), ok: false, notes: [message] }, null, 2)); else io.err(`asight on: ${message}`)
    return EXIT.incomplete
  }
}
