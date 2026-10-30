// findings.mjs (src/netenv) — what `trocar doctor` says about the network (RFC 1.6 附录 B): the catalogue of findings, one entry per code, and `diagnose`, which says which of them the facts and the topology call for.
// A finding is `{ code, class, harness?, what, why, commands: [{ run, shell }], verify }`. The commands are whole lines with every value filled in (pid, port, path, user): a value that could not be read is
// written 「不知道 · <原因>」 with the command that reads it, never a `<…>` placeholder. trocar's own commands come first, then the application's or the OS's. Nothing here runs anything (R8): `doctor` only
// prints them. Pure: facts and topology in, findings out.
import { detectDrift, isWrittenPlace } from './adopt.mjs'
import { hopKey, firstHopAfterTrocar, firstHopOff } from './topology-text.mjs'
import { parseProxyUrl } from './redact.mjs'
import { trustReasonText } from '../collector/core/codes.mjs'
import { TRUST_REASONS, ROUTE_TRUST_REASONS, RESTART_REASONS } from '../health/codes.mjs'
import { FINDINGS_WIN32 } from './findings-win32.mjs'

const BY_CLASS = { problem: 0, expected: 1, note: 2 }
const nodeOf = (t, id) => t.nodes.find((n) => n.id === id)

// ── what a command is ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const trocar = (ctx, run) => ({ run, shell: ctx.sh })
/** An install item of the form that drifted (proxy mode: the carrier, a wrapper or a plugin; 1.6 §9.3 row 31): the command its `certificate` names, `trocar install`. */
const installFix = (c) => (c.fm && c.fm.certificate && c.fm.certificate.command ? [trocar(c, c.fm.certificate.command)] : null)
const os = (ctx, byPlatform) => ({ run: byPlatform[ctx.platform] || byPlatform.linux, shell: ctx.platform === 'win32' ? 'powershell' : 'sh' })
const gui = (run) => ({ run, shell: 'gui' })
const unknownValue = (what, reason) => `unknown ${what} (${reason})`

/**
 * Where a proxy setting lives, for a command that names the line to edit: the place the facts read it from (`setting.source[0]`: a variable of the shell that starts the agent, or a key of one of its files;
 * a value from the second file is that file, a value from the shell is not in any file), else, for a setting that is not there yet, the first file the harness reads one from, else the variable it reads.
 */
function placeOf(hf, setting) {
  const b = hf.behaviour || {}, files = b.fileKeys || []
  const s = setting && Array.isArray(setting.source) ? setting.source[0] : null
  if (s && s.kind === 'env') return { kind: 'env', name: s.where }
  if (s && s.kind === 'file') { const f = files.find((x) => x.path === s.where); return { kind: 'file', path: s.where, key: s.key || (f && f.key) || '', format: f ? f.format : /\./.test(s.key || '') ? 'json' : 'dotenv' } }
  if (s) return { kind: 'system' }
  if (files[0]) return { kind: 'file', ...files[0] }
  return { kind: 'env', name: (b.env && b.env[0]) || 'HTTPS_PROXY' }
}
/** The step that puts `value` where the setting lives. One verb for one step (附录 B). */
function setAt(h, place, value) {
  if (place.kind === 'env') return `In the terminal that starts ${h}, run: export ${place.name}=${value}`
  if (place.kind === 'system') return `Set your system proxy to ${value}`
  return place.format === 'json' ? `Set ${place.key} in ${place.path} to "${value}"` : `Put the line ${place.key}=${value} in ${place.path}`
}
/** The step that takes the setting away from where it lives. */
function removeAt(h, place) {
  if (place.kind === 'env') return `In the terminal that starts ${h}, run: unset ${place.name}`
  if (place.kind === 'system') return 'Turn off your system proxy'
  return place.format === 'json' ? `Remove ${place.key} from ${place.path}` : `Remove the ${place.key}= line from ${place.path}`
}
// darwin: the kernel's own TCP table, the one `status` reads (arch/darwin/netfacts.mjs) — `lsof -nP -iTCP:<port> -sTCP:LISTEN` names only the
// processes whose fd table this user may open, so a port held by ANOTHER user's program came back empty, which is the case this step is for.
const portCheck = (ctx, port) => os(ctx, { linux: `ss -ltnp 'sport = :${port}'`, darwin: `netstat -anv -p tcp | grep -E '\\.${port} .*LISTEN'`, win32: `netstat -ano -p TCP | findstr ":${port}"` })
/** The steps that make an agent read its settings again: the words of the form the process belongs to (`fm.restart` — its places are `fm.paths`, so an
 *  extension's app-server gets the editor's reload, not the CLI's kill), else the harness's own (`behaviour.restart`); and, where the harness keeps its
 *  settings in a managed process its windows do not end (`restart.managed`), the command that ends it, with the pid the facts hold. A managed process that
 *  is not running has nothing to end. */
function restartSteps(ctx) {
  const r = formRestart(ctx) || (ctx.hf.behaviour && ctx.hf.behaviour.restart) || {}
  const steps = [gui(r.hint ? r.hint : `Quit every ${ctx.h} window, then start it again`)]
  if (r.managed === true && r.processes) {
    const name = r.processes.split(/\s+/).filter((t) => !t.startsWith('-')).join(' ') // `codex app-server --managed-daemon` -> the name a process of it is listed under: `codex app-server`
    for (const p of ctx.hf.procs) if (p.name === name) steps.push(os(ctx, { linux: `kill ${p.pid}`, darwin: `kill ${p.pid}`, win32: `Stop-Process -Id ${p.pid}` }))
  }
  return steps
}
// which form a process runs from: the first form one of whose places (`paths`) its executable is under. One file path, compared the way both platforms
// spell it (separators and case): no form of any harness is told apart by either.
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const under = (exe, at) => { const a = norm(at); const e = norm(exe); return e === a || e.startsWith(`${a}/`) }
function formRestart(ctx) {
  const p = (ctx.hf.procs || []).find((x) => x.pid === ctx.pid && x.exe) || null
  const fm = p ? (ctx.hf.forms || []).find((f) => (f.paths || []).some((at) => under(p.exe, at))) : null
  return (fm && fm.restart) || (ctx.fm && ctx.fm.restart) || null
}
const settingOf = (hf) => (hf.setting && !hf.setting.unknown && hf.setting.value ? hf.setting : ((hf.forms || []).map((f) => f.setting).find((s) => s && s.value) || null))
const deadProxy = (t) => t.nodes.find((n) => n.kind === 'proxy' && n.down === true) || null
/** The places of the USER's own that hold the address this finding is about (`diagnose` filtered them: a key trocar wrote is never among them, 1.6 附录 B `places`). */
const userPlaces = (c) => (Array.isArray(c.places) ? c.places : [])
/** The steps that take that address out of the user's own settings, one named step per place; with no place known, the one the setting was read from. */
const removeSteps = (c) => (userPlaces(c).length ? userPlaces(c).map((p) => gui(removeAt(c.h, p))) : [gui(c.setting ? removeAt(c.h, placeOf(c.hf, c.setting)) : unknownValue('setting', 'absent'))])

/** not-routed, by the reason the model's route plan gave the form (`fm.route.reason`, src/collector/core/proxymode/entries.mjs; 4.11 §3, 1.6 附录 B): the why, and the steps
 *  (the place the plan named in `at`, else `unknown`). A PAC the facts see and no reason of the plan's is the PAC row; nothing known is the generic row. */
function notRoutedOf(c) {
  const r = (c.fm && c.fm.route) || {}, at = r.at || unknownValue('place', 'absent'), on = trocar(c, `trocar on ${c.h}`)
  if (r.reason === 'system-pac' || (!r.reason && c.pac)) return { why: 'The system proxy it follows is a PAC script, which trocar does not run.', commands: [gui(`${setAt(c.h, placeOf(c.hf, c.setting), unknownValue('proxy address', 'pac'))}`), on] }
  if (r.reason === 'blocker' || r.reason === 'own-egress') return { why: `A setting of yours (${at}) keeps ${c.h} off any entry trocar can use.`, commands: [gui(`Remove the setting at ${at}`), on] }
  if (r.reason === 'blocker-unreadable' || r.reason === 'unreadable') return { why: `trocar cannot read ${at}, so it did not connect this form.`, commands: [gui(`Make ${at} readable, or fix it`), on] }
  if (r.reason === 'absent') return { why: `${c.h}'s entry file ${at} does not exist, and trocar does not create it.`, commands: [gui(`Run ${c.h}'s own setup so that it creates ${at}`), on] }
  if (r.reason === 'credentialed-own-leg') return { why: 'This form\'s entry takes no login, so trocar does not hand it an upstream that needs one.', commands: [gui(`Use a proxy without a login for ${c.h}, or use its CLI form`), on] }
  if (r.reason === 'no-path' || r.reason === 'no-applied-entry') return { why: `trocar found no entry for this form of ${c.h}${r.at ? ` (${r.at})` : ''}.`, commands: [gui(`Start ${c.h} once so that it writes its own settings`), on] }
  if (r.reason === 'no-carrier') return { why: 'This form has no certificate yet.', commands: [trocar(c, 'trocar install'), on] }
  return { why: 'This form has no entry trocar can use.', commands: [gui(`Use ${c.h}'s CLI form instead`), trocar(c, `trocar status ${c.h}`)] }
}

/** The catalogue (附录 B). `applies` is `diagnose`'s business; each entry says what it is. `cls` is the class, or a function of the context where it depends (`proxy-changed`). */
export const FINDINGS = {
  'desired-off': { cls: 'expected', trocarFirst: true, what: (c) => `Capture is off for ${c.h}.`, why: () => 'trocar is not on its path: it connects directly, or through your own proxy.', commands: (c) => [trocar(c, `trocar on ${c.h}`)], verify: (c) => `trocar status ${c.h}` },
  'daemon-not-running': { cls: 'problem', trocarFirst: true, what: () => 'trocar is not running in the background, so nothing is captured.', why: () => 'Without it there is no engine, and new connections go straight out.', commands: (c) => [trocar(c, `trocar on${c.h ? ` ${c.h}` : ''}`)], verify: () => 'trocar status' },
  'daemon-not-responding': { cls: 'problem', trocarFirst: true, what: () => 'trocar runs in the background but does not answer, so nothing is captured.', why: () => 'Its heartbeat is stale, so new connections already go straight out.', commands: (c) => [trocar(c, 'trocar off'), trocar(c, `trocar on${c.h ? ` ${c.h}` : ''}`)], verify: () => 'trocar status' },
  'helper-missing': { cls: 'problem', trocarFirst: false, what: () => 'trocar\'s capture helper is missing or is the wrong version.', why: () => 'Without it trocar cannot attach to the kernel, so nothing is captured.', commands: (c) => [{ run: 'sudo trocar setup-helper', shell: 'sh' }, trocar(c, `trocar on${c.h ? ` ${c.h}` : ''}`)], verify: () => 'trocar status' },
  'link-missing': { cls: 'problem', trocarFirst: true, what: () => 'Capture is on, but trocar is not attached, so nothing is captured.', why: () => 'New connections go straight out.', commands: (c) => [trocar(c, `trocar on${c.h ? ` ${c.h}` : ''}`)], verify: () => 'trocar status' },
  'entry-missing': { cls: 'problem', trocarFirst: true, what: (c) => `${c.h}'s setting that points at trocar is gone.`, why: () => 'It was removed, or it was never written.', commands: (c) => installFix(c) || [trocar(c, `trocar on ${c.h}`)], verify: (c) => `trocar status ${c.h}` },
  'entry-changed': { cls: 'problem', trocarFirst: true, what: (c) => `${c.h}'s setting that points at trocar holds something else now.`, why: () => 'You, or another program, changed what trocar wrote.', commands: (c) => installFix(c) || [trocar(c, `trocar off ${c.h}`), trocar(c, `trocar on ${c.h}`)], verify: (c) => `trocar status ${c.h}` },
  'negative-cache': { cls: 'problem', trocarFirst: true, what: (c) => `${c.h}${c.pid ? ` (pid ${c.pid})` : ''} refused trocar's certificate; it is forwarded only.`, why: () => 'Certificates are read when a program starts.', commands: (c) => [...restartSteps(c), trocar(c, `trocar status ${c.h}`)], verify: (c) => `trocar status ${c.h}` },
  'not-routed': { cls: 'problem', trocarFirst: false, what: (c) => `New connections from ${c.h} do not go through trocar.`, why: (c) => notRoutedOf(c).why, commands: (c) => notRoutedOf(c).commands, verify: (c) => `trocar status ${c.h}` },
  'route-loop': { cls: 'problem', trocarFirst: true, what: (c) => `trocar's upstream for ${c.h} would be trocar itself.`, why: () => 'The proxy setting trocar read already points at one of trocar\'s own ports, so trocar did not connect this form.', commands: (c) => [trocar(c, `trocar off ${c.h}`), gui(setAt(c.h, placeOf(c.hf, c.setting), c.old || unknownValue('proxy address', 'absent'))), trocar(c, `trocar on ${c.h}`)], verify: (c) => `trocar doctor ${c.h}` },
  'proxy-dead': { cls: 'problem', trocarFirst: false, what: (c) => `Nothing is listening on ${c.dead.addr}:${c.dead.port}, the proxy ${c.h} is set to use.`, why: () => 'Your proxy is not running; trocar did not write this setting.',
    places: userPlaces, commands: (c) => [gui(`Start your proxy, so that it listens on ${c.dead.addr}:${c.dead.port}`), ...removeSteps(c), portCheck(c, c.dead.port)], verify: (c) => `trocar status ${c.h}` },
  'proxy-unsupported': { cls: 'problem', trocarFirst: false, what: (c) => `${c.h} does not support the proxy scheme ${c.setting.scheme}.`, why: (c) => (c.silent ? `${c.h} connects directly and says nothing, so that proxy has no effect.` : `${c.h} cannot use a ${c.setting.scheme} proxy.`),
    commands: (c) => [gui(setAt(c.h, placeOf(c.hf, c.setting), c.setting.host && c.setting.port ? `http://${c.setting.host}:${c.setting.port}` : unknownValue('proxy address', 'absent')))], verify: (c) => `trocar status ${c.h}` },
  'proxy-changed': { cls: (c) => (c.F.routing === 'proxy' ? 'problem' : 'expected'), trocarFirst: true, what: (c) => `${c.h}'s proxy setting is not the one trocar connected to.`, why: () => 'You changed it.',
    commands: (c) => (c.F.routing === 'proxy' ? [trocar(c, `trocar on ${c.h}`), trocar(c, `trocar off ${c.h}`)] : [trocar(c, `trocar status ${c.h}`)]), verify: (c) => `trocar status ${c.h}` },
  'elevated-agent': { cls: 'problem', trocarFirst: false, what: (c) => `${c.h}${c.pid ? ` (pid ${c.pid})` : ''} runs elevated, so trocar only forwards it.`, why: () => 'trocar never decrypts an elevated process.', commands: () => [gui('Quit it and start it again without administrator rights')], verify: (c) => `trocar status ${c.h}` },
  'forwarder-down': { cls: 'problem', trocarFirst: true, what: (c) => `trocar is not listening${c.port ? ` on :${c.port}` : ''}, so ${c.h || 'your agents'} cannot connect.`, why: () => 'The port lives with trocar\'s background process, which is not there.', commands: (c) => [trocar(c, 'trocar on'), trocar(c, `trocar off ${c.h}`)], verify: () => 'trocar status' },
  'upstream-unreachable': { cls: 'problem', trocarFirst: false, what: (c) => `trocar cannot reach the proxy${c.upPort ? ` :${c.upPort}` : ''} it uses for ${c.h}.`, why: () => 'Your proxy has quit while a setting still points at it; without trocar it would not connect either.',
    places: userPlaces,
    // trocar's door is on the path, and its upstream is the address nobody answers: the key trocar wrote holds the door, so removing THAT changes nothing
    // (`off` would write the prior value back). What to take away, to get off this proxy for good, are their own keys that still name it.
    commands: (c) => [gui('Start your proxy, or turn off the system proxy that points at it'), ...(userPlaces(c).length ? [trocar(c, `trocar off ${c.h}`), ...userPlaces(c).map((p) => gui(removeAt(c.h, p))), trocar(c, `trocar on ${c.h}`)] : []),
      ...(c.upPort ? [portCheck(c, c.upPort)] : [])], verify: (c) => `trocar status ${c.h}` },
  'shim-not-on-path': { cls: 'problem', trocarFirst: true, what: (c) => `${c.h} does not start through the program trocar installed.`, why: () => 'Another command of the same name comes first on PATH, or it was started another way.',
    commands: (c) => [trocar(c, 'trocar install'), gui(`Quit ${c.h} and start it again from a new terminal`)], verify: (c) => `trocar status ${c.h}` },
  'egress-differs': { cls: 'note', trocarFirst: false, what: (c) => `Some of ${c.h}'s connections now leave through a different hop.`, why: () => 'In proxy mode a form has one upstream, so traffic that used to split now takes that one.', commands: (c) => [trocar(c, `trocar off ${c.h}`)], verify: (c) => `trocar status ${c.h}` },
  'linger-off': { cls: 'note', trocarFirst: false, what: () => 'Capture stops when you log out.', why: () => 'Your login session owns trocar\'s background process.', commands: (c) => [{ run: `loginctl enable-linger ${c.user || '"$(id -un)"'}`, shell: 'sh' }], verify: () => 'trocar status' },
  'system-proxy-pac': { cls: 'note', trocarFirst: false, what: () => 'Your system proxy is a PAC script, so the next hop is unknown.', why: () => 'trocar does not run PAC scripts.', commands: (c) => [os(c, { win32: "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name AutoConfigURL", darwin: 'scutil --proxy', linux: 'gsettings get org.gnome.system.proxy autoconfig-url' })], verify: () => 'trocar status' },
  'other-redirector': { cls: 'note', trocarFirst: false, what: () => 'Something else on this machine also rewrites connections.', why: () => 'It may rewrite the same connections trocar does.', commands: (c) => [os(c, { linux: 'sudo bpftool cgroup tree /sys/fs/cgroup', win32: 'netsh winsock show catalog', darwin: 'netstat -rn' })], verify: () => 'trocar status' },
  'fake-ip': { cls: 'note', trocarFirst: false, what: (c) => `${c.h}'s API host resolves inside 198.18.0.0/15, a fake IP range.`, why: () => 'trocar records the host from the TLS handshake, not from the address.', commands: () => [], verify: () => 'trocar status' },
  'inferred-behaviour': { cls: 'note', trocarFirst: false, what: (c) => `${c.h}'s proxy behaviour on this platform is inferred, not measured.`, why: () => 'It was measured on another platform.', commands: () => [], verify: () => 'trocar status' },
  // the name list (D51): a process on no list used the harness's entry (forwarded only), and agents.json's own problems. Not a WIDE name: the line to add, every value filled in;
  // an interpreter name needs args (its script), and trocar does not keep command lines, so that line cannot be written (no `<…>` is left, an unknown value is said)
  'process-unknown': { cls: 'note', trocarFirst: false, what: (c) => `A process named ${c.u.name ?? unknownValue('name', 'unreadable')} (pid ${c.u.pid ?? unknownValue('pid', 'unreadable')}) used ${c.h}'s proxy but is not listed.`,
    why: (c) => (c.u.named ? `That name is listed for ${c.h}, but only with argument patterns this process did not match.` : `trocar matches agents by process name, and this one is on no list.`),
    commands: (c) => [gui(c.u.name == null ? unknownValue('name', 'the name of that process could not be read') : c.u.wide ? `An interpreter name needs its script name, which trocar does not keep: add ${c.u.name} with an "args" pattern to the agents list in ${c.listPath}`
      : c.u.named ? `A line without "args" would claim every process named ${c.u.name}: add this one with its own "args" pattern to the agents list in ${c.listPath}`
      : `Add ${JSON.stringify({ harness: c.h, name: c.u.name })} to the agents list in ${c.listPath} (create it as {"version":1,"agents":[...]} if it is not there); no restart needed`)], verify: (c) => `trocar status ${c.h}` },
  'agent-list-invalid': { cls: 'problem', trocarFirst: false, what: (c) => `${c.file.path} has ${c.file.problems.length} bad entr${c.file.problems.length === 1 ? 'y' : 'ies'}; the rest is still used.`, why: (c) => (c.file.state === 'ok' ? 'A bad entry does not apply; the others do.' : 'The whole file does not apply, so only the built-in names are used.'),
    commands: (c) => c.file.problems.map((p) => gui(`${p.index == null ? `Fix ${c.file.path}` : `Fix or remove entry ${p.index + 1} of ${c.file.path}`}: ${p.detail}`)), verify: () => 'trocar status' },
  'cert-key-missing': { cls: 'problem', trocarFirst: true, what: () => 'The key for trocar\'s root is gone, so trocar only forwards.', why: () => 'It was removed from your keychain or key store.', commands: (c) => [trocar(c, 'trocar install')], verify: () => 'trocar status' },
  'cert-intermediate-unavailable': { cls: 'problem', trocarFirst: false, what: () => 'trocar cannot sign certificates right now, so it only forwards.', why: () => 'There is no desktop login session, or your keychain is locked.',
    commands: (c) => [gui('Log in to the desktop session on this machine and unlock your keychain'), trocar(c, 'trocar status')], verify: () => 'trocar status' },
  'not-users-file': { cls: 'expected', trocarFirst: false, what: (c) => `${c.h} points at a certificate file that is not yours; trocar left it alone.`, why: () => 'trocar only appends to files you own.',
    commands: (c) => [gui(`Point ${c.h}'s certificate setting at a file you own`), trocar(c, 'trocar install')], verify: (c) => `trocar status ${c.h}` },
  'not-verified': { cls: 'expected', trocarFirst: false, what: (c) => `This form of ${c.h} is not verified on this platform yet; it is forwarded only.`, why: () => 'trocar only decrypts the forms it has verified.',
    commands: (c) => [gui(`No action needed: ${c.h} keeps working, and these connections are not decrypted`)], verify: (c) => `trocar status ${c.h}` },
  'prior-proxy-unknown': { cls: 'note', trocarFirst: false, what: (c) => `trocar could not recover the proxy ${c.h}${c.pids && c.pids.length ? ` (pid ${c.pids.join(', ')})` : ''} started with.`,
    why: () => 'The process that set it has quit, so trocar uses the system proxy, or none.', commands: (c) => [gui(setAt(c.h, placeOf(c.hf, null), unknownValue('proxy address', 'env-unreadable'))), trocar(c, `trocar on ${c.h}`), gui(`Restart ${c.h}`)],
    verify: (c) => `trocar status ${c.h}` },
  'collectors-online': { cls: 'problem', trocarFirst: true, what: (c) => `Capture is still on${c.online ? ` for ${c.online}` : ''}, so nothing was uninstalled.`, why: () => 'trocar never turns capture off for you.', commands: (c) => [trocar(c, 'trocar off'), trocar(c, 'trocar uninstall')], verify: () => 'trocar status' },
  // The user named the harness, and nothing in the facts explains it. trocar has no fact that says an agent cannot connect, so this does not claim it: a condition, a note.
  'cause-unknown': { cls: 'note', trocarFirst: true, what: (c) => `If ${c.h} still cannot connect: trocar found no cause on its side.`, why: () => 'Nothing trocar read explains it.',
    commands: (c) => [trocar(c, `trocar off ${c.h}`), gui(`Try ${c.h} again: if it still fails, trocar is not the cause; if it works, run trocar on ${c.h} and then trocar doctor ${c.h}`)], verify: (c) => `Try ${c.h} again` },
}
// the trust reasons not listed above (a variable missing, a file unreadable, …): the daemon's own hint says what to do about this agent
const TRUST = { cls: (c) => (RESTART_REASONS.includes(c.code) ? 'expected' : 'problem'), trocarFirst: false, what: (c) => `${c.h} is not captured${RESTART_REASONS.includes(c.code) ? `${c.pid ? `: pid ${c.pid} started` : ': it started'} before capture was on.` : `${c.pid ? `: pid ${c.pid}` : ''}.`}`,
  why: (c) => c.hint || trustReasonText(c.code) || 'Certificates are read when a program starts.',
  commands: (c) => (RESTART_REASONS.includes(c.code) ? restartSteps(c) : [trocar(c, `trocar status ${c.h}`), gui(c.hint || trustReasonText(c.code) || `Follow ${c.h}'s own instructions`)]), verify: (c) => `trocar status ${c.h}` }

/** Every code a finding may carry: the cross-platform catalogue's, the Windows table's (4.8 §10.4) and the trust reasons' — the Windows collector's own trust reasons (ROUTE_TRUST_REASONS, 4.8 §12) included,
 *  for the same reason TRUST_REASONS is: they are the codes of `agent-untrusted` a form's verdict can carry. The schema validates against this list. */
export const FINDING_CODES = Object.freeze([...new Set([...Object.keys(FINDINGS), ...Object.keys(FINDINGS_WIN32), ...TRUST_REASONS, ...ROUTE_TRUST_REASONS])])

// ── which of them the facts call for ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One finding: on win32 the Windows table (4.8 §10.4) takes precedence, field by field — an entry there may override only the commands (or the why), and one for a code the cross-platform catalogue
 *  does not have defines every field itself. A code neither catalogue names falls to the trust entry: the reasons the tracker can set are data, not caller bugs (the closed sets live in
 *  health/codes.mjs, held by its tests — a runtime throw here would take `doctor` down with a proxy-mode state like `smart-app-control`). */
function make(code, ctx) {
  const w = ctx.platform === 'win32' ? FINDINGS_WIN32[code] : null
  const def = FINDINGS[code] || TRUST
  const c = { ...ctx, code }
  c.removeOwn = userPlaces(c).map((p) => gui(removeAt(c.h, p))) // the user's own places, as steps: both catalogues name them (1.6 附录 B)
  const clsOf = (d) => (typeof d.cls === 'function' ? d.cls(c) : d.cls)
  const at = (f) => (w && w[f] ? w[f](c) : def[f](c))
  const pl = def.places ? def.places(c) : null
  return { code, class: w && w.cls !== undefined ? clsOf(w) : clsOf(def), ...(ctx.h ? { harness: ctx.h } : {}), what: at('what'), why: at('why'), commands: at('commands'), verify: at('verify'), ...(pl && pl.length ? { places: pl } : {}) }
}

/** One finding outside `diagnose`, for a command that refuses with a catalogued code (uninstall's collectors-online). */
export const findingFor = (code, { platform = process.platform, h = null, ...rest } = {}) => make(code, { platform, h, sh: platform === 'win32' ? 'powershell' : 'sh', ...rest })

/** Does what the path depends on come from behaviour data that was measured on another platform? Only where the data decides the path: the agent has a proxy of its own, or follows an OS proxy that is there. */
function inferred(F, hf) {
  if (!['driver', 'proxy'].includes(F.routing) || (hf.behaviour && hf.behaviour.measured) === 'lab') return false
  const b = hf.behaviour || {}
  return !!(settingOf(hf) || (hf.setting && hf.setting.unknown) || ((b.follows && (b.follows.http || b.follows.ws)) && hf.systemProxy))
}

/**
 * The findings for the facts and the topology they were drawn into (§9.6). `harnesses` = names (only those harnesses' findings, and the hint `cause-unknown` when one of them has no failure or expected finding that explains it) or null (all of
 * them, and the machine's). `user` is the name to put in a command that needs it. Pure: it reads nothing, runs nothing.
 */
export function diagnose({ facts: F, topology: T, harnesses = null, user = null }) {
  const out = [], named = Array.isArray(harnesses) && harnesses.length > 0
  const ids = Object.keys(F.harnesses).filter((h) => !named || harnesses.includes(h))
  const sh = F.platform === 'win32' ? 'powershell' : 'sh'
  const adopted = Object.fromEntries(Object.entries(F.harnesses).filter(([, x]) => x.adopted).map(([h, x]) => [h, x.adopted]))
  for (const h of ids) {
    const hf = F.harnesses[h], t = T[h]
    if (!hf || !t) continue
    const base = { F, h, hf, t, user, sh, platform: F.platform, setting: settingOf(hf) }
    const found = new Map(), add = (code, extra = {}) => { if (!found.has(code)) found.set(code, make(code, { ...base, ...extra })) }
    const formOf = (r) => { const b = (t.branches || []).find((x) => x.reason === r); return (b && (hf.forms || []).find((f) => f.id === b.form)) || null } // the form facts of the branch that carries the reason (its route / entryPlace, the doctor's Windows rows read them, 4.8 §10.4)
    const reasons = [...new Set([t.reason, ...t.branches.map((b) => b.reason)].filter(Boolean))]
    const row = hf.procs.find((p) => p.reason && reasons.includes(p.reason))
    const sysPac = !!((hf.systemProxy && hf.systemProxy.pac) || (hf.forms || []).some((f) => f.systemProxy && f.systemProxy.pac))
    const upstream = Object.values((F.forwarder && F.forwarder.forms) || {}).map((x) => x.upstream).find((u) => u && u !== 'DIRECT')
    const upAddr = upstream ? parseProxyUrl(upstream) : null
    // the places of the user's OWN that hold an address, for a finding that asks them to remove it by hand: a place trocar wrote (its value is the door, and
    // `off` puts the user's own back) is never one of them — known from this harness's on-phase manifest items (`writtenPlaces`), whatever the format
    const placesAt = (host, port) => (hf.proxyPlaces || []).filter((p) => p.host === host && String(p.port) === String(port) && !isWrittenPlace(hf.writtenPlaces, p))
    // the doctor's own name for a protocol the upstream cannot take replaces the branch's not-routed (4.8 §10.4: upstream-protocol sits on the proxy-unsupported row)
    const protoForm = (hf.forms || []).find((f) => f.route && f.route.code === 'proxy-unsupported') || null
    for (const r of reasons.filter((x) => !(protoForm && x === 'not-routed'))) add(r, { upPort: upAddr ? upAddr.port : undefined, places: upAddr ? placesAt(upAddr.host, upAddr.port) : [], hint: row && row.reason === r ? row.hint : undefined, pid: row && row.reason === r ? row.pid : undefined, pac: sysPac, fm: formOf(r) })
    if (protoForm) add('proxy-unsupported', { protocol: protoForm.route.protocol, fm: protoForm })
    const dead = deadProxy(t)
    // trocar's door on the path with the dead address as its upstream is `upstream-unreachable`, not `proxy-dead`: the setting the agent reads is trocar's
    // own door, which is up; what is dead is the hop after it, and without trocar the agent would not connect either (1.6 附录 B)
    if (dead) {
      const viaTrocar = !!(upAddr && upAddr.host === dead.addr && String(upAddr.port) === String(dead.port))
      add(viaTrocar ? 'upstream-unreachable' : 'proxy-dead', { dead, places: placesAt(dead.addr, dead.port), ...(viaTrocar ? { upPort: dead.port } : {}) })
    }
    const s = base.setting
    if (s && s.scheme && ((hf.behaviour.unsupported || {})[s.scheme] || !(hf.behaviour.schemes || []).includes(s.scheme))) add('proxy-unsupported', { silent: (hf.behaviour.unsupported || {})[s.scheme] === 'silent-direct' })
    if (sysPac) add('system-proxy-pac')
    if (t.branches.some((b) => b.path.some((id) => (nodeOf(t, id) || {}).trocar) && hopKey(firstHopAfterTrocar(t, b)) !== hopKey(firstHopOff(t, b)) && firstHopAfterTrocar(t, b))) add('egress-differs')
    // drift is what the user changed in the files, not what this shell happens to export; and a harness that is off has no drift to report (trocar is not on its path)
    const drifts = F.desired[h] === 'off' ? [] : detectDrift({ adopted, h, setting: hf.fileSetting || hf.setting, routing: F.routing, scope: 'files' })
    if (F.routing === 'driver' && drifts.some((d) => d.code === 'proxy-changed')) add('proxy-changed')
    for (const fm of hf.forms || []) { const fwf = F.forwarder && F.forwarder.forms && F.forwarder.forms[fm.id]; if (fwf && fwf.source === 'unknown') add('prior-proxy-unknown', { pids: fm.procs.map((p) => p.pid) }) }
    // the certificate axis of each form (proxy mode, 1.6 §9.4): one that is not in effect gives its own code, with the form's command (4.11 §3 ⑱)
    for (const fm of hf.forms || []) { const k = fm.certificate; if (k && !k.in_effect && k.code && FINDINGS[k.code]) add(k.code, { fm }) }
    if (hf.fakeIp === true) add('fake-ip')
    if (inferred(F, hf)) add('inferred-behaviour')
    const listPath = F.agentList ? F.agentList.path : null
    for (const u of (F.identity && F.identity[h] && F.identity[h].unknown) || []) found.set(`process-unknown\u0000${u.name}`, make('process-unknown', { ...base, u, listPath }))
    if (named && F.desired[h] === 'on' && hf.installed !== false && ![...found.values()].some((f) => f.class !== 'note')) add('cause-unknown') // a failure or an expected finding already says why; only hints (about the data) leave it open
    out.push(...[...found.values()].sort((a, b) => BY_CLASS[a.class] - BY_CLASS[b.class]))
  }
  if (!named) {
    const host = { F, h: null, hf: null, t: null, user, sh, platform: F.platform }
    if (F.linger === false) out.push(make('linger-off', host))
    if (F.cert && F.cert.key === 'missing') out.push(make('cert-key-missing', host)) // the daemon's issuer (its /status `cert`, 4.11 P2): the key first, it explains the intermediate
    else if (F.cert && F.cert.intermediate === 'unavailable') out.push(make('cert-intermediate-unavailable', host))
    if (F.otherRedirector === true) out.push(make('other-redirector', host))
    const file = F.agentList
    if (file && file.problems.length) out.push(make('agent-list-invalid', { ...host, file }))
  }
  return out
}

/**
 * The findings as lines for a person (附录 B · §3.7): a problem or an expected finding is numbered, a note is prefixed `Note:`; then `Fix` with one command
 * to a line and `Check` with the one that verifies it. Wrapped to 80 columns, except a path or a command, which keeps its own line unbroken.
 */
export function renderFindings(findings, { width = 80 } = {}) {
  const lines = []
  let n = 0
  for (const f of fold(findings)) {
    const head = f.class === 'note' ? 'Note: ' : `${(n += 1)}. `
    const pad = ' '.repeat(head.length)
    lines.push(...wrap(`${f.what}`, width - head.length).map((l, i) => (i ? pad : head) + l))
    if (f.why) lines.push(...wrap(f.why, width - head.length).map((l) => pad + l))
    f.commands.forEach((c, i) => {
      // a note is not a problem, so what it offers is not a `Fix` (a macOS test machine 2026-10-18: a Fix sat under the headline "no problems")
      const label = i === 0 ? `${pad}${f.class === 'note' ? 'Option' : 'Fix   '} ` : `${pad}       `
      wrap(c.run, width - label.length).forEach((l, k) => lines.push((k ? `${pad}       ` : label) + l))
    })
    if (f.verify) lines.push(`${pad}Check  ${f.verify}`)
  }
  return lines
}

const nameList = (l) => (l.length === 1 ? l[0] : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`)
/**
 * §3.7: one line per fact, not per harness. Several harnesses whose note is the same fact with the same reason and nothing to do about it
 * (the same sentence four times on a macOS test machine, 2026-10-18) become one note that names them. The document keeps a finding per
 * harness — this is how it is read out. Notes that carry a command are never folded: what to do is about one harness.
 */
function fold(findings) {
  const key = (f) => (f.class === 'note' && f.harness && !f.commands.length ? [f.code, f.why, f.verify].join('\u0000') : null)
  const groups = new Map()
  for (const f of findings) { const k = key(f); if (k) groups.set(k, [...(groups.get(k) || []), f]) }
  const done = new Set(), out = []
  for (const f of findings) {
    const k = key(f)
    if (!k) { out.push(f); continue }
    if (done.has(k)) continue
    done.add(k)
    const g = groups.get(k)
    out.push(g.length === 1 ? f : { ...f, what: f.what.replace(f.harness, nameList(g.map((x) => x.harness))) })
  }
  return out
}

/** `text` into lines of at most `width` columns, broken on spaces; a word longer than the line keeps its own line. */
function wrap(text, width) {
  const out = []
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (out.length && out[out.length - 1].length + 1 + word.length <= width) out[out.length - 1] += ` ${word}`
    else out.push(word)
  }
  return out.length ? out : ['']
}
