// on.mjs — `asight on [harness…] [--dry-run] [--yes] [--no-autostart|--no-unit] [--json]` (RFC 1.6 §1.1, §1.6, §2, R4–R7): the front end of
// turnOn (src/collector/install.mjs). It parses the arguments, builds what turnOn needs from the platform (the descriptors, the process table,
// the autostart unit, the control socket), decides how a confirmation is asked, and prints the plan and the receipt. Everything the world gives is a
// `deps` entry a test replaces (0.1 §3): `parts` (the descriptors, `scan`, `match`, the arch), `exec` (the runner of OS tools: spawnSync-shaped),
// `request` (the control socket), `helperState`, `linger` / `lingerRead`, `now`, `freePort`, `sleep`, `roots`, `user`, `getuid`, `fs`, `script`.
// A platform without a collector is refused by loadArch's own error.
// Exit codes (R4): 0 done · 1 not done or a problem · 2 usage error / not in a terminal without --yes (nothing touched).
import os from 'node:os'
import nodeFs from 'node:fs'
import path from 'node:path'
import { resolveHarnesses } from './harness-names.mjs'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, confirm as ask } from '../off/io.mjs'
import { formatOnReceipt, formatPlan } from './receipt.mjs'
import { colors, noColor } from './text.mjs'
import { renderCompact } from '../netenv/topology-text.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { readAgentList } from '../off/identity.mjs'
import { prepareAdoption, editedFields, recordAdoption } from './on-adopt.mjs'
import { refuseOldManifest } from '../off/manifest.mjs'
import { commandNamed, usageLine } from './commands.mjs'
import { isModelOs } from '../collector/model-install.mjs'
import { runModelOn } from './on-model.mjs'

const USAGE = usageLine(commandNamed('on'))
const FLAGS = new Set(['--dry-run', '--yes', '--no-autostart', '--no-unit', '--json'])
const chainText = (t) => renderCompact(t).join(' ; ')
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)

/** → the exit code. `argv` is what follows `on`. `io` = { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo). */
export async function runOnCli(argv, { io, env = process.env, home = os.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set(), names = []
  for (const a of argv) {
    if (a.startsWith('-')) {
      if (!FLAGS.has(a)) { io.err(`asight on: unknown option '${a.split('=')[0]}'\n${USAGE}`); return EXIT.usage }
      flags.add(a)
    } else names.push(a)
  }
  if (flags.has('--no-autostart') && flags.has('--no-unit')) { io.err(`asight on: --no-autostart and --no-unit exclude each other (the first writes the unit and starts it once, the second writes none)\n${USAGE}`); return EXIT.usage }
  const named = resolveHarnesses(names)
  if (!named.ok) { io.err(`asight on: unknown harness ${named.unknown.join(', ')}; the names are: ${named.known.join(', ')}`); return EXIT.usage }
  const json = flags.has('--json')
  const say = json ? io.err : io.out // stdout holds the one JSON in --json mode (R5); warnings and the plan go to stderr
  const c = json ? noColor() : colors(io) // --json never colours (D46); a non-TTY or NO_COLOR run colours nothing anywhere
  if ((deps.getuid || processUid)() === 0) { io.err('asight on: 用你自己的账号跑,不要用 root / sudo(D36;只有 `sudo asight setup-helper` 要 root)'); return EXIT.incomplete }
  // 4.11 ⑰: a manifest of version 1 / 2 is refused before anything else, before any write — the standalone copy is not rewritten either
  const old = refuseOldManifest({ home, platform, fs: deps.fs || nodeFs })
  if (old) {
    const receipt = { ...newReceipt('on'), ok: false, harnesses: named.ids, notes: [old.message] }
    if (json) io.out(JSON.stringify(receipt, null, 2)); else io.err(`asight on: ${old.message}`)
    return EXIT.incomplete
  }
  try {
    // the name list in effect (D51③): the presets plus ~/.asight/agents.json, as the daemon and `status` judge — the running processes the plan restarts and whose CAs it carries
    const parts = deps.parts || await (await (deps.daemon || import('../collector/daemon.mjs'))).loadParts({ env, platform, agentList: readAgentList({ home, fs: deps.fs || nodeFs }).entries })
    const install = deps.install || await import('../collector/install.mjs')
    const model = isModelOs(parts.os) // macOS / Windows: the collector model's on (on-model.mjs); none of the old adoption / routing code runs there
    const fs = deps.fs || nodeFs
    // The Node floor (4.8 §7, W24: the daemon is pulled up by THIS Node at every login, so an older one cannot run the collector): the arch's own read of
    // process.versions, asked first because it is free — ok:false refuses with the doctor line, before anything is touched. No flows record: the receipt
    // is it (nothing of asight's may exist yet, and the closed sets hold no code for this). Linux's arch has no nodePreflight and nothing here changes.
    if (parts.arch && typeof parts.arch.nodePreflight === 'function') {
      const pf = parts.arch.nodePreflight()
      if (pf && pf.ok === false) {
        const receipt = { ...newReceipt('on'), ok: false, harnesses: named.ids, notes: [pf.doctor] }
        if (json) io.out(JSON.stringify(receipt, null, 2))
        else io.out(formatOnReceipt(receipt, { tense: 'past', home }))
        return EXIT.incomplete
      }
    }
    // R7 (4.8 §7): `on` never runs with an elevated or SYSTEM token — the arch's own question (the helper's `token` verb, self-started and closed by
    // refuseElevated), asked before anything is touched: turnOn is `on`'s only writer, so this stops it before its first write, and
    // the adoption read never runs under an elevated shell either. A token that cannot be read is not a refusal (R11: an on that stopped on a broken
    // question is not an on). Linux's arch has no refuseElevated and nothing here changes. The record's `where` is the §12 table's 'start' — that code
    // lives there whichever command asked (checkRecord's closed set); with no collector directory yet the receipt is the record (4.6 §记录).
    if (parts.arch && typeof parts.arch.refuseElevated === 'function') {
      const refusal = await parts.arch.refuseElevated({ env, onUnknown: (why) => io.err(`[elevated] ${why}`) })
      if (refusal) {
        const receipt = { ...newReceipt('on'), ok: false, harnesses: named.ids, notes: [refusal.reason] }
        const cdir = path.join(home, '.asight', 'collector')
        try { if (fs.existsSync(cdir)) appendEvent(cdir, { event: 'failure', where: 'start', code: refusal.code, reason: refusal.reason }) } catch { /* the receipt is the record then (R11) */ }
        if (json) io.out(JSON.stringify(receipt, null, 2))
        else io.out(formatOnReceipt(receipt, { tense: 'past', home }))
        return EXIT.incomplete
      }
    }
    if (model) return await runModelOn({ io, env, home, os: parts.os, deps, parts, flags, ids: named.ids, json })
    const script = deps.script || process.argv[1]
    const unit = flags.has('--no-unit') || !parts.arch || !parts.arch.unit || !parts.arch.unit.userUnit ? null : parts.arch.unit.userUnit({ home, node: process.execPath, script, run: deps.exec || null, env })
    const helperState = deps.helperState || (parts.arch && parts.arch.install && parts.arch.install.helperState ? () => parts.arch.install.helperState() : null)
    const autostart = !flags.has('--no-autostart')
    const yes = flags.has('--yes')
    const confirm = async (plan) => {
      if (yes) return true
      if (!isInteractive(io)) return null // not a terminal: the plan is all we print (R6)
      return ask({ ...io, prompt: json ? io.stderr : io.stdout }, 'asight 将按上面的清单写或改这些文件。继续?')
    }
    const adoption = await prepareAdoption({ home, env, platform, deps, parts, now: deps.now ? () => deps.now().getTime() : Date.now }) // §9.5: the proxy each agent already uses, and the chain once asight is on
    const routing = deps.routing || (parts.arch && typeof parts.arch.routing === 'function' ? parts.arch.routing({ harnesses: parts.harnesses, home, env, fs: deps.fs }) : null) // §9.5's proxy-mode routing: the platform supplies it beside prepare (win32, Task 8(c)); a platform without one (Linux's driver mode) adopts nothing extra and every existing on is its guard
    const planText = (raw) => {
      const adopted = adoption && !adoption.error ? Object.entries(adoption.chains(raw.targets)).filter(([h]) => raw.targets.includes(h)).map(([h, t]) => ({ harness: h, chain: chainText(t) })).filter((x) => /\s->\s/.test(x.chain) || false) : [] // D46: the degenerate one-hop chain says nothing and is not printed
      return formatPlan({ ...raw, adopted }, { home, autostart, platform, colors: c })
    }
    // The combined bundles' OS roots are the arch's (the flip checklist ②, 4.9 §4 末): the plan asks it through the one resolver (tls/roots.mjs bundleRoots), so the FIRST
    // install's bundles carry them — not only the daemon's next rebuild — and a read that fails stops the on before one file of the agents' is touched (D38); `deps.roots` overrides them.
    let { receipt, exit, plan } = await install.turnOn({
      home, env, ids: named.ids, osName: parts.os, harnesses: parts.harnesses, scan: parts.scan, match: parts.match, arch: parts.arch || null,
      roots: deps.roots || null, unit, autostart, freePort: deps.freePort, dryRun: flags.has('--dry-run'), confirm,
      networkEdited: async (targets) => editedFields({ adoption, routing, targets, home, env, fs: deps.fs }),
      onPlan: (p) => say(planText(p)),
      request: deps.request, now: deps.now, getuid: deps.getuid, helperState, linger: deps.linger || parts.linger || null, lingerRead: deps.lingerRead || (deps.linger ? null : parts.lingerRead || null), sleep: deps.sleep, user: deps.user, fs: deps.fs,
    })
    if (adoption && adoption.error) receipt.notes.push(adoption.error)
    else if (adoption && receipt.harnesses && receipt.harnesses.length && receipt.ok !== false && !receipt.dry_run && !receipt.planned && !receipt.declined) {
      const rec = await recordAdoption({ adoption, routing, targets: receipt.harnesses, home, env, now: deps.now ? () => deps.now().getTime() : Date.now, fs: deps.fs })
      receipt.adopted = rec.adopted
      if (rec.wrote) receipt.created.push(rec.wrote)
      for (const h of rec.failed) receipt.ok = false
      receipt.notes.push(...rec.notes)
      if (rec.failed.length) exit = EXIT.incomplete
    } else if (adoption && receipt.dry_run) receipt.adopted = Object.fromEntries(Object.entries(adoption.chains(receipt.harnesses || [])).filter(([h]) => (receipt.harnesses || []).includes(h)).map(([h, t]) => [h, { chain: chainText(t), dry_run: true }]))
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else if (receipt.planned) for (const n of receipt.notes) io.err(n) // the plan was printed; what is left to say is why nothing was done (R6)
    else {
      // D46: the harnesses THIS run newly wired (their one-time 说明 notes print; a harness wired before keeps its notes in doctor and --json — the receipt object is untouched, R5/R11)
      const fresh = plan ? new Set((plan.targets || []).filter((id) => !(plan.installed || []).includes(id))) : null
      io.out(formatOnReceipt(receipt, { tense: receipt.dry_run ? 'future' : 'past', home, platform, fresh, colors: c }))
    }
    return exit
  } catch (e) {
    const message = String((e && e.message) || e)
    if (json) io.out(JSON.stringify({ ...newReceipt('on'), ok: false, notes: [message] }, null, 2)); else io.err(`asight on: ${message}`)
    return EXIT.incomplete
  }
}
