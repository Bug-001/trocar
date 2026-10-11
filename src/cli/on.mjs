// on.mjs — `asight on [harness…] [--dry-run] [--yes] [--no-autostart|--no-unit] [--json]` (RFC 1.6 §1.1, §1.6, §2, R4–R7): the front end of
// turnOn (src/collector/install.mjs). It parses the arguments, builds what turnOn needs from the platform (the descriptors, the process table,
// the autostart unit, the control socket), decides how a confirmation is asked, and prints the plan and the receipt. Everything the world gives is a
// `deps` entry a test replaces (0.1 §3): `parts` (the descriptors, `scan`, `match`, the arch), `exec` (the runner of OS tools: spawnSync-shaped),
// `request` (the control socket), `helperState`, `linger` / `lingerRead`, `now`, `freePort`, `sleep`, `roots`, `user`, `getuid`, `fs`, `script`.
// A platform without a collector is refused by loadArch's own error (D39⑥ executed 2026-10-11: the old capture's on went with it).
// Exit codes (R4): 0 done · 1 not done or a problem · 2 usage error / not in a terminal without --yes (nothing touched).
import os from 'node:os'
import tls from 'node:tls'
import nodeFs from 'node:fs'
import path from 'node:path'
import { resolveHarnesses } from './harness-names.mjs'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, confirm as ask } from '../off/io.mjs'
import { formatOnReceipt, formatPlan, formatWinPlan } from './receipt.mjs'
import { probeNetenv } from '../netenv/index.mjs'
import { renderCompact } from '../netenv/topology-text.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { prepareAdoption, editedFields, recordAdoption } from './on-adopt.mjs'

const USAGE = 'usage: asight on [harness…] [--dry-run] [--yes] [--opt-in <形态>[,<形态>…]] [--no-autostart | --no-unit] [--json]'
const FLAGS = new Set(['--dry-run', '--yes', '--no-autostart', '--no-unit', '--json'])
const PROXY_HINT = 'asight on 不认 --proxy:按进程采集器不需要它(D39 之前的 --proxy 是旧 CC-CLI steer 的口子,已随旧采集退役,D39⑥)'
const chainText = (t) => renderCompact(t).join(' ; ')
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)

/** The forms of `--opt-in` out of `argv`: repeatable, comma-separated, `--opt-in a` and `--opt-in=a,b` both read (1.6 §1.7). → { optIn, rest } —
 *  `rest` is argv without the flag and its values, so the plain flag loop never sees a form id; a `--opt-in` without a value is a usage error. */
function splitOptIn(argv) {
  const optIn = [], rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--opt-in') {
      if (i + 1 >= argv.length) return { error: '--opt-in needs a form id after it (repeatable, comma-separated)' }
      for (const f of String(argv[++i]).split(',')) if (f !== '') optIn.push(f)
    } else if (a.startsWith('--opt-in=')) { for (const f of a.slice('--opt-in='.length).split(',')) if (f !== '') optIn.push(f) }
    else rest.push(a)
  }
  return { optIn, rest }
}

/** → the exit code. `argv` is what follows `on`. `io` = { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo). */
export async function runOnCli(argv, { io, env = process.env, home = os.homedir(), platform = process.platform, deps = {} } = {}) {
  const picked = splitOptIn(argv)
  if (picked.error) { io.err(`asight on: ${picked.error}\n${USAGE}`); return EXIT.usage }
  const { optIn } = picked
  argv = picked.rest
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
  if ((deps.getuid || processUid)() === 0) { io.err('asight on: 用你自己的账号跑,不要用 root / sudo(D36;只有 `sudo asight setup-helper` 要 root)'); return EXIT.incomplete }
  try {
    const parts = deps.parts || await (await (deps.daemon || import('../collector/daemon.mjs'))).loadParts({ env })
    const install = deps.install || await import('../collector/install.mjs')
    // the opt-in half (1.6 §1.7): the arch that has opt-in items (Windows, 4.8 §2.4) hands `forms` (the ids --opt-in may name), `plan` (the rows)
    // and `apply`; an arch with none (Linux today) makes every --opt-in name a usage error, never a silent skip
    const optInHooks = deps.optIn || (parts.arch && parts.arch.optIn) || null
    if (optIn.length) {
      const known = optInHooks && typeof optInHooks.forms === 'function' ? optInHooks.forms({ harnesses: parts.harnesses, ids: named.ids }) : []
      const unknown = [...new Set(optIn)].filter((f) => !known.includes(f))
      if (unknown.length) {
        io.err(`asight on: --opt-in 名了不认识的形态 ${unknown.join(', ')}${known.length ? `;可以点名的形态是: ${known.join(', ')}` : ';这个平台没有要点名的形态(1.6 §1.7)'}`)
        return EXIT.usage
      }
    }
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
    // refuseElevated), asked before anything is touched: turnOn is `on`'s only writer, so this stops it before its first write, and the netenv probe and
    // the adoption read never run under an elevated shell either. A token that cannot be read is not a refusal (R11: an on that stopped on a broken
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
    const script = deps.script || process.argv[1]
    const unit = flags.has('--no-unit') || !parts.arch || !parts.arch.unit || !parts.arch.unit.userUnit ? null : parts.arch.unit.userUnit({ home, node: process.execPath, script, run: deps.exec || null, env })
    const helperState = deps.helperState || (parts.arch && parts.arch.install && parts.arch.install.helperState ? () => parts.arch.install.helperState() : null)
    const autostart = !flags.has('--no-autostart')
    const yes = flags.has('--yes')
    const confirm = async (plan) => {
      if (yes) return true
      if (!isInteractive(io)) return null // not a terminal: the plan is all we print (R6)
      // the one confirmation of an admin-level opt-in item names what changes and why it needs the administrator (V63): after this yes, the OS's own
      // prompt (UAC) carries the step — asight never draws a password field of its own
      const admin = ((plan && plan.optIn) || []).filter((r) => r.chosen && r.applicable && r.scope === 'machine')
      const prompt = admin.length
        ? `asight 将按上面的清单写或改这些文件,并做 ${admin.length} 个你点名的机器级改动(要管理员权限;你确认后 Windows 弹它自己的提权框,密码只进那个框)。继续?`
        : 'asight 将按上面的清单写或改这些文件。继续?'
      return ask({ ...io, prompt: json ? io.stderr : io.stdout }, prompt)
    }
    // the machine's VPN / proxy software (§6): looked at once, named in the plan and in the receipt; asight changes none of it. The cache ~/.asight/netenv.json is `status`'s and `doctor`'s to write, not `on`'s:
    // the receipt lists exactly the files `on` wrote (V3), and a second `on` writes nothing (R9)
    const netenv = await probeNetenv({ home, platform, env, deps })
    const adoption = await prepareAdoption({ home, env, platform, deps, parts, netenv, now: deps.now ? () => deps.now().getTime() : Date.now }) // §9.5: the proxy each agent already uses, and the chain once asight is on
    const routing = deps.routing || (parts.arch && typeof parts.arch.routing === 'function' ? parts.arch.routing({ harnesses: parts.harnesses, home, env, fs: deps.fs }) : null) // §9.5's proxy-mode routing: the platform supplies it beside prepare (win32, Task 8(c)); a platform without one (Linux's driver mode) adopts nothing extra and every existing on is its guard
    // The arch's read-only preflight (4.8 §8 ⑥, W27 ⑥, W74; Windows: the kernel line and the Smart App Control line), run BEFORE turnOn so a refusal
    // stops `on` before its first write — a settled precondition with nothing to roll back. The Linux arch has no `prepare` and nothing here changes.
    // The refusal's event and receipt are on's to write; with no collector directory yet (nothing installed) the receipt is the record (4.6 §记录).
    const archPrepare = parts.arch && typeof parts.arch.prepare === 'function' ? parts.arch.prepare : null
    const prep = archPrepare ? await archPrepare({ env, home }) : null
    // D44: the same arch's ensureKernel hook, run by turnOn as the FIRST write-phase action — after the confirmation, before any agent file — so a failed
    // download leaves zero agent files written (the plan above already showed the download line; a dry run returns before turnOn reaches the hook). An arch
    // without one (Linux's driver mode, or the kernel already ensured and nothing to do) hands no hook and nothing changes.
    const ensureKernelHook = parts.arch && typeof parts.arch.ensureKernel === 'function' ? parts.arch.ensureKernel : null
    const afterConfirm = ensureKernelHook ? () => ensureKernelHook({ home, env }) : null
    // the plan of 4.8 §11: Windows draws its own (the kernel line, one row per entry group with the upstream, the named opt-in items, Smart App Control, the drain note) — fed by the same
    // `on`'s facts (adoption) and the arch hook's answer (prep). The Linux plan and the hook's own notes stay as they are.
    const winPlan = parts.os === 'win32'
    const planText = (raw) => {
      const adopted = adoption && !adoption.error ? Object.entries(adoption.chains(raw.targets)).filter(([h]) => raw.targets.includes(h)).map(([h, t]) => ({ harness: h, chain: chainText(t) })) : []
      return winPlan
        ? formatWinPlan(raw, { home, autostart, netenv, env, adoption: adoption && !adoption.error ? adoption : null, prep })
        : [formatPlan({ ...raw, adopted }, { home, autostart, netenv }), ...(prep && prep.notes && prep.notes.length ? ['', ...prep.notes] : [])].join('\n')
    }
    if (prep && prep.refuse) {
      const rf = prep.refuse
      const line = `${rf.reason}${Array.isArray(rf.commands) && rf.commands.length ? `。手动替代(asight 不替你跑): ${rf.commands.join(' 或 ')}` : ''}`
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
    // The OS roots of an arch that READS them instead of naming one file (the flip checklist ②, 4.9 §4 末 — daemon.mjs's daily rebuild has its arm already): without this the
    // FIRST install's combined bundles are composed with an empty `osText`, and a replace-semantics entry (Codex's SSL_CERT_FILE) silently cuts the agent off its relay until the
    // next daily rebuild. The arm is not darwin's alone: it is any arch with `osRoots` set and `osRootsFile` unset (today only darwin, whose union is the keychain-administered
    // anchors ∪ Node's bundled ∪ Apple's SystemRootCertificates, 4.9 §6.2) — another arch reaching here gets the same service for free. A read that fails entirely stops the on
    // before one file of the agents' is touched (D38: a bundle quietly missing the enterprise roots is the bug this wiring exists to close); `deps.roots` overrides it, as ever.
    const archOsRoots = !deps.roots && !parts.osRootsFile && parts.arch && typeof parts.arch.osRoots === 'function' ? await parts.arch.osRoots() : null
    let { receipt, exit, plan } = await install.turnOn({
      home, env, ids: named.ids, osName: parts.os, harnesses: parts.harnesses, scan: parts.scan, match: parts.match, osRootsFile: parts.osRootsFile || null,
      roots: deps.roots || (archOsRoots ? { node: [...tls.rootCertificates], osText: archOsRoots.pem } : null), unit, autostart, freePort: deps.freePort, dryRun: flags.has('--dry-run'), confirm,
      optIn, optInHooks, afterConfirm,
      networkEdited: async (targets) => editedFields({ adoption, routing, targets, home, env, fs: deps.fs }),
      onPlan: (p) => say(planText(p)),
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
    else if (winPlan && receipt.dry_run && plan) io.out(`${planText(plan)}\n\n${formatOnReceipt(receipt, { tense: 'future', home })}`) // a Windows dry run prints the §11 plan as well: it is what a user reads before deciding (turnOn's onPlan does not run for one)
    else io.out(formatOnReceipt(receipt, { tense: receipt.dry_run ? 'future' : 'past', home }))
    return exit
  } catch (e) {
    const message = String((e && e.message) || e)
    if (json) io.out(JSON.stringify({ ...newReceipt('on'), ok: false, notes: [message] }, null, 2)); else io.err(`asight on: ${message}`)
    return EXIT.incomplete
  }
}
