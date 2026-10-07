// findings.mjs (src/netenv) — what `asight doctor` says about the network (RFC 1.6 §9.6): the catalogue of findings, one entry per code, and `diagnose`, which says which of them the facts and the topology call for.
// A finding is `{ code, class, harness?, what, why, commands: [{ run, shell }], verify }`. The commands are whole lines with every value filled in (pid, port, path, user): a value that could not be read is
// written 「不知道 · <原因>」 with the command that reads it, never a `<…>` placeholder. asight's own commands come first, then the application's or the OS's. Nothing here runs anything (R8): `doctor` only
// prints them. Pure: facts and topology in, findings out.
import { detectDrift } from './adopt.mjs'
import { hopKey, firstHopAfterAsight, firstHopOff } from './topology-text.mjs'
import { parseProxyUrl } from './redact.mjs'
import { trustReasonText } from '../collector/core/codes.mjs'
import { TRUST_REASONS } from '../health/codes.mjs'

const RESTART_REASONS = ['config-after-start', 'env-frozen', 'start-time-unknown', 'no-marker', 'kimi-not-via-shim'] // what restarting the agent fixes (1.6 §1.1)
const BY_CLASS = { failure: 0, expected: 1, hint: 2 }
const nodeOf = (t, id) => t.nodes.find((n) => n.id === id)

// ── what a command is ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const asight = (ctx, run) => ({ run, shell: ctx.sh })
const os = (ctx, byPlatform) => ({ run: byPlatform[ctx.platform] || byPlatform.linux, shell: ctx.platform === 'win32' ? 'powershell' : 'sh' })
const gui = (run) => ({ run, shell: 'gui' })
const unknownValue = (what, reason) => `不知道 · ${reason}(${what})`

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
/** The step that puts `value` where the setting lives. */
function setAt(h, place, value) {
  if (place.kind === 'env') return `在启动 ${h} 的终端里 export ${place.name}=${value}`
  if (place.kind === 'system') return `在系统代理设置里把它改成 ${value}`
  return place.format === 'json' ? `${place.path} 里的 ${place.key} 写成 "${value}"` : `${place.path} 里写一行 ${place.key}=${value}`
}
/** The step that takes the setting away from where it lives. */
function removeAt(h, place) {
  if (place.kind === 'env') return `在启动 ${h} 的终端里 unset ${place.name}`
  if (place.kind === 'system') return '在系统代理设置里关掉它'
  return place.format === 'json' ? `删掉 ${place.path} 里的 ${place.key}` : `删掉 ${place.path} 里的 ${place.key}= 那一行`
}
const portCheck = (ctx, port) => os(ctx, { linux: `ss -ltnp 'sport = :${port}'`, darwin: `lsof -nP -iTCP:${port} -sTCP:LISTEN`, win32: `netstat -ano -p TCP | findstr ":${port}"` })
const restartStep = (ctx) => gui(ctx.hf.behaviour && ctx.hf.behaviour.restart && ctx.hf.behaviour.restart.hint ? ctx.hf.behaviour.restart.hint : `退出 ${ctx.h},再重新启动`)
const settingOf = (hf) => (hf.setting && !hf.setting.unknown && hf.setting.value ? hf.setting : ((hf.forms || []).map((f) => f.setting).find((s) => s && s.value) || null))
const deadProxy = (t) => t.nodes.find((n) => n.kind === 'proxy' && n.down === true) || null

/** The catalogue. `applies` is `diagnose`'s business; each entry says what it is. `cls` is the class, or a function of the context where it depends (§9.6: `proxy-changed`). */
export const FINDINGS = {
  'desired-off': { cls: 'expected', asightFirst: true, what: (c) => `${c.h} 现在是关着的(期望态 off)`, why: () => '你(或 asight off)把它关了:asight 不在它的路径上,它直连或走自己的代理', commands: (c) => [asight(c, `asight on ${c.h}`)], verify: (c) => `asight status ${c.h}:被采集「是」` },
  'daemon-not-running': { cls: 'failure', asightFirst: true, what: () => '守护进程没在跑', why: () => '没有它就没有引擎,新连接不被采集(入口之外的驱动已随助手一起没了)', commands: (c) => [asight(c, `asight on ${c.h}`)], verify: () => 'asight status:守护进程「在跑」' },
  'daemon-not-responding': { cls: 'failure', asightFirst: true, what: () => '守护进程在跑但没响应', why: () => '心跳过期,新连接已因此直连;它卡住了', commands: (c) => [asight(c, 'asight off'), asight(c, `asight on ${c.h}`)], verify: () => 'asight status:守护进程「在跑」' },
  'helper-missing': { cls: 'failure', asightFirst: false, what: () => '能力助手缺失或版本不对', why: () => '没有它就挂不上内核里的驱动', commands: (c) => [{ run: 'sudo asight setup-helper', shell: 'sh' }, asight(c, `asight on ${c.h}`)], verify: () => 'asight status:link 已挂' },
  'link-missing': { cls: 'failure', asightFirst: true, what: () => '期望开,但内核里没有本实例的 link', why: () => '驱动没挂上,新连接直连', commands: (c) => [asight(c, `asight on ${c.h}`)], verify: () => 'asight status:link 已挂' },
  'entry-missing': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 的信任入口不在了`, why: () => '入口(asight 写进它配置的那一项)被删了或还没写', commands: (c) => [asight(c, `asight on ${c.h}`)], verify: (c) => `asight status ${c.h}:信任入口完好` },
  'entry-changed': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 的信任入口被改成了别的`, why: () => '你或别的程序改了 asight 写的那一项', commands: (c) => [asight(c, `asight off ${c.h}`), asight(c, `asight on ${c.h}`)], verify: (c) => `asight status ${c.h}:信任入口完好` },
  'negative-cache': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 的进程拒绝了 asight 的证书,那个 host 之后透传`, why: () => '这个形态不认 asight 的信任入口;(pid, host) 随进程记着', commands: (c) => [asight(c, `asight status ${c.h}`), restartStep(c)], verify: (c) => `重启后 asight status ${c.h}:「是」` },
  'not-routed': { cls: 'failure', asightFirst: false, what: (c) => `${c.h} 的新连接不经过 asight`, why: (c) => (c.pac ? '它跟随的系统代理是 PAC,asight 不执行 PAC' : '这个形态没有 asight 能用的入口'),
    commands: (c) => (c.pac ? [gui(`把 ${c.h} 的代理设成一个具体地址:${setAt(c.h, placeOf(c.hf, c.setting), c.vpnProxy || unknownValue('你的代理地址', 'pac'))}`), asight(c, `asight on ${c.h}`)] : [gui(`${c.h} 的这个形态没有入口:改用它的 CLI 形态`), asight(c, `asight status ${c.h}`)]), verify: (c) => `asight status ${c.h}:该支「在路径上 · 是」` },
  'route-loop': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 的上游又是 asight 自己`, why: () => '算出的上游是 asight 自己的端口:代理字段的原值就是内核端口,或系统代理指着它;on 因此不接这个形态', commands: (c) => [asight(c, `asight off ${c.h}`), gui(`把 ${c.h} 的代理改回你原来的:${setAt(c.h, placeOf(c.hf, c.setting), c.old || unknownValue('原来的代理', 'absent'))}`), asight(c, `asight on ${c.h}`)], verify: () => 'asight doctor:不再报' },
  'proxy-dead': { cls: 'failure', asightFirst: false, what: (c) => `${c.h} 配的代理 ${c.dead.addr}:${c.dead.port} 没人在听`, why: () => '你的代理软件没开;这个设置不是 asight 写的',
    commands: (c) => [gui(`打开你的代理软件(它应该监听 ${c.dead.addr}:${c.dead.port})`), gui(`或者删掉这个设置:${c.setting ? removeAt(c.h, placeOf(c.hf, c.setting)) : unknownValue('这个设置', 'absent')}`), portCheck(c, c.dead.port)], verify: (c) => `同一条命令看到监听;asight status ${c.h} 那一跳有属主` },
  'proxy-unsupported': { cls: 'failure', asightFirst: false, what: (c) => `${c.h} 配了它不支持的代理协议(${c.setting.scheme})`, why: (c) => (c.silent ? `${c.h} 不支持 ${c.setting.scheme},会静默直连,代理形同虚设` : `${c.h} 不支持 ${c.setting.scheme}`),
    commands: (c) => [gui(`把它改成 HTTP 代理:${setAt(c.h, placeOf(c.hf, c.setting), c.setting.host && c.setting.port ? `http://${c.setting.host}:${c.setting.port}` : unknownValue('代理地址', 'absent'))}`)], verify: (c) => `asight status ${c.h}:那条边是 proxy-http` },
  'proxy-changed': { cls: (c) => (c.F.routing === 'proxy' ? 'failure' : 'expected'), asightFirst: true, what: (c) => `${c.h} 的代理设置与上次 on 接上的不同`, why: () => '你改了它',
    commands: (c) => (c.F.routing === 'proxy' ? [asight(c, `asight on ${c.h}`), asight(c, `asight off ${c.h}`)] : [asight(c, `asight status ${c.h}`)]), verify: (c) => `asight status ${c.h}` },
  'netenv-changed': { cls: 'hint', asightFirst: true, what: () => '本机网络环境与上次 on 时不同', why: () => '(VPN 新装、退出、换模式)别的变化不改 asight 的路,只改拓扑', commands: (c) => [asight(c, 'asight status')], verify: () => 'asight status' },
  'elevated-agent': { cls: 'failure', asightFirst: false, what: (c) => `${c.h} 以管理员权限运行`, why: () => '自带内核按进程认 agent,看不到提权进程的名字,只转发', commands: (c) => [gui(`关掉它,以普通权限重新启动 ${c.h}(不用「以管理员身份运行」)`)], verify: (c) => `asight status ${c.h}` },
  'forwarder-down': { cls: 'failure', asightFirst: true, what: () => 'asight 自带内核没在跑,入口指向它的 agent 连不上', why: () => '进程退出或被杀;守护进程按退避拉起,连续 5 次失败才报', commands: (c) => [asight(c, 'asight on'), asight(c, `asight off ${c.h}`)], verify: () => 'asight status:内核「在跑」' },
  'upstream-unreachable': { cls: 'failure', asightFirst: false, what: (c) => `asight 给 ${c.h} 接的上游连不上`, why: () => '你的代理软件退出了而系统代理还指着它,或你配的代理不通;没有 asight 时同样连不上',
    commands: (c) => [gui('打开你的代理软件,或关掉指着它的系统代理'), ...(c.upPort ? [portCheck(c, c.upPort)] : [])], verify: (c) => `asight status ${c.h}:那一跳有属主` },
  'opt-in-needed': { cls: 'expected', asightFirst: true, what: (c) => `${c.h} 的这个形态要你点名才能采`, why: () => '它的入口改的东西影响超出这个 agent(§1.7)', commands: (c) => [asight(c, c.enable || `asight on ${c.h} --opt-in ${c.form || c.h}`)], verify: (c) => `asight status ${c.h}:该支「是」` },
  'shim-not-on-path': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 的入口(shim)没被用上`, why: () => '机器 PATH 里的同名命令排在用户 PATH 前面,或 agent 不是经入口启动的',
    commands: (c) => [asight(c, c.enable || `asight on ${c.h} --opt-in ${c.form || c.h}`), gui('不是经入口启动的:退出它,从 asight 的入口或新开的终端启动')], verify: (c) => `asight status ${c.h}` },
  'not-via-entry': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 不是经 asight 的入口启动的`, why: () => '任务栏固定、登录自启、IDE 按绝对路径、改 PATH 之前开的终端',
    commands: (c) => [asight(c, c.enable || `asight status ${c.h}`), gui('退出它,从 asight 的入口或新开的终端启动')], verify: (c) => `asight status ${c.h}` },
  'needs-admin': { cls: 'failure', asightFirst: false, what: (c) => `${c.h} 点名的机器级项还没做,或 off 之后还没撤`, why: () => '要管理员权限,asight 不自己提权(§1.7)', commands: (c) => [{ run: c.elevated || unknownValue('提权命令', 'absent'), shell: c.sh }], verify: () => 'asight status:不再列' },
  'egress-differs': { cls: 'hint', asightFirst: false, what: (c) => `asight 接上后,${c.h} 的一部分连接出口与原来不同`, why: () => '代理模式下一个形态只有一个上游:原本分两路的(如 HTTP 跟随系统代理、WebSocket 直连),接上后都走那一个', commands: (c) => [asight(c, `asight off ${c.h}`)], verify: () => '—' },
  'linger-off': { cls: 'hint', asightFirst: false, what: () => '登出后停采(未开 linger)', why: () => '用户登出后 systemd 会停掉你的服务,守护进程也在其中', commands: (c) => [{ run: `loginctl enable-linger ${c.user || '"$(id -un)"'}`, shell: 'sh' }], verify: () => 'asight status:不再印这一行' },
  'system-proxy-pac': { cls: 'hint', asightFirst: false, what: () => '系统代理是 PAC', why: () => 'asight 不执行 PAC,下一跳不知道', commands: (c) => [os(c, { win32: "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name AutoConfigURL", darwin: 'scutil --proxy', linux: 'gsettings get org.gnome.system.proxy autoconfig-url' })], verify: () => '—' },
  'other-redirector': { cls: 'hint', asightFirst: false, what: () => '本机还有别的连接改写', why: () => '根 cgroup 上有别人的 connect 程序(如 dae),或有 Winsock LSP:可能与 asight 互相改写', commands: (c) => [os(c, { linux: 'sudo bpftool cgroup tree /sys/fs/cgroup', win32: 'netsh winsock show catalog', darwin: 'netstat -rn' })], verify: () => '—' },
  'fake-ip': { cls: 'hint', asightFirst: false, what: (c) => `${c.h} 的 API host 解析到 198.18.0.0/15`, why: () => 'VPN 的 fake-ip;asight 按 SNI 记 host', commands: () => [], verify: () => '—' },
  'inferred-behaviour': { cls: 'hint', asightFirst: false, what: (c) => `${c.h} 在本平台的代理行为是按别的平台实测推断的`, why: () => '本平台还没测', commands: () => [], verify: () => '—' },
  // The user named the harness (§9.1: the symptom is said by agent), and nothing in the facts explains it. asight has no fact that says an agent cannot connect, so this does not claim it: a condition, a hint.
  'cause-unknown': { cls: 'hint', asightFirst: true, what: (c) => `如果 ${c.h} 仍连不上:asight 这边没找到具体原因`, why: () => 'asight 读到的(期望态、进程、信任入口、代理设置)里没有哪一项能解释它;你点名了它,所以给出怎样把 asight 排除在外',
    commands: (c) => [asight(c, `asight off ${c.h}`), gui(`再试 ${c.h}:仍连不上 → 与 asight 无关;连得上 → ${`asight on ${c.h}`},再跑 asight doctor ${c.h} --json,并看看板「采集健康」里那段时间的失败`)], verify: (c) => `再试 ${c.h}:仍连不上 → 与 asight 无关` },
}
// the trust reasons not listed above (a variable missing, a file unreadable, …): the daemon's own hint says what to do about this agent
const TRUST = { cls: (c) => (RESTART_REASONS.includes(c.code) ? 'expected' : 'failure'), asightFirst: false, what: (c) => `${c.h} 的进程没被信任:${c.code}`, why: (c) => c.hint || trustReasonText(c.code) || '入口只在启动时读(§1.1);遮住的原因见 harness 的提示',
  commands: (c) => (RESTART_REASONS.includes(c.code) ? [restartStep(c)] : [asight(c, `asight status ${c.h}`), gui(c.hint || trustReasonText(c.code) || `按 ${c.h} 的提示改`)]), verify: (c) => `asight status ${c.h}:新 pid「是」` }
export const FINDING_CODES = Object.freeze([...new Set([...Object.keys(FINDINGS), ...TRUST_REASONS])])

// ── which of them the facts call for ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function make(code, ctx) {
  const def = FINDINGS[code] || TRUST
  const c = { ...ctx, code }
  const cls = typeof def.cls === 'function' ? def.cls(c) : def.cls
  return { code, class: cls, ...(ctx.h ? { harness: ctx.h } : {}), what: def.what(c), why: def.why(c), commands: def.commands(c), verify: def.verify(c) }
}

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
    const base = { F, h, hf, t, user, sh, platform: F.platform, setting: settingOf(hf), vpnProxy: F.vpn && F.vpn.port ? `http://127.0.0.1:${F.vpn.port}` : null }
    const found = new Map(), add = (code, extra = {}) => { if (!found.has(code)) found.set(code, make(code, { ...base, ...extra })) }
    const reasons = [...new Set([t.reason, ...t.branches.map((b) => b.reason)].filter(Boolean))]
    const row = hf.procs.find((p) => p.reason && reasons.includes(p.reason))
    const optIn = (hf.forms || []).map((f) => f.optIn).find((o) => o && o.state !== 'done' && o.state !== 'unknown')
    const sysPac = !!((hf.systemProxy && hf.systemProxy.pac) || (hf.forms || []).some((f) => f.systemProxy && f.systemProxy.pac))
    const adminOpt = optIn && ['pending-admin', 'needs-admin'].includes(optIn.state)
    const upstream = Object.values((F.forwarder && F.forwarder.forms) || {}).map((x) => x.upstream).find((u) => u && u !== 'DIRECT')
    for (const r of reasons.filter((x) => !(adminOpt && x === 'not-routed'))) add(r, { upPort: upstream ? (parseProxyUrl(upstream) || {}).port : undefined, hint: row && row.reason === r ? row.hint : undefined, pac: sysPac, enable: optIn && optIn.enable, form: optIn && optIn.form })
    if (adminOpt) add('needs-admin', { elevated: optIn.elevated })
    const dead = deadProxy(t)
    if (dead) add('proxy-dead', { dead })
    const s = base.setting
    if (s && s.scheme && ((hf.behaviour.unsupported || {})[s.scheme] || !(hf.behaviour.schemes || []).includes(s.scheme))) add('proxy-unsupported', { silent: (hf.behaviour.unsupported || {})[s.scheme] === 'silent-direct' })
    if (sysPac) add('system-proxy-pac')
    if (t.branches.some((b) => b.path.some((id) => (nodeOf(t, id) || {}).asight) && hopKey(firstHopAfterAsight(t, b)) !== hopKey(firstHopOff(t, b)) && firstHopAfterAsight(t, b))) add('egress-differs')
    // drift is what the user changed in the files, not what this shell happens to export; and a harness that is off has no drift to report (asight is not on its path)
    const drifts = F.desired[h] === 'off' ? [] : detectDrift({ adopted, h, setting: hf.fileSetting || hf.setting, routing: F.routing, scope: 'files', vpn: F.vpnKnown === false ? undefined : F.vpn })
    if (F.routing === 'driver' && drifts.some((d) => d.code === 'proxy-changed')) add('proxy-changed')
    if (drifts.some((d) => d.code === 'netenv-changed')) add('netenv-changed')
    if (hf.fakeIp === true) add('fake-ip')
    if (inferred(F, hf)) add('inferred-behaviour')
    if (named && F.desired[h] === 'on' && hf.installed !== false && ![...found.values()].some((f) => f.class !== 'hint')) add('cause-unknown') // a failure or an expected finding already says why; only hints (about the data) leave it open
    out.push(...[...found.values()].sort((a, b) => BY_CLASS[a.class] - BY_CLASS[b.class]))
  }
  if (!named) {
    const host = { F, h: null, hf: null, t: null, user, sh, platform: F.platform }
    if (F.linger === false) out.push(make('linger-off', host))
    if (F.otherRedirector === true) out.push(make('other-redirector', host))
  }
  return out
}

/** The findings as lines for a person: what, why, then each command on a line of its own with its shell, and how to check. */
export function renderFindings(findings) {
  const CLASS = { failure: '失败', expected: '预期', hint: '提示' }
  return findings.flatMap((f) => [
    `[${CLASS[f.class]}] ${f.harness ? `${f.harness} · ` : ''}${f.code} — ${f.what}`, `  为什么: ${f.why}`,
    ...f.commands.map((c, i) => `  ${i === 0 ? '怎么做:' : '       '} ${c.shell === 'gui' ? c.run : `$ ${c.run}`}${c.shell === 'powershell' ? '  (PowerShell)' : ''}`), `  怎么验证: ${f.verify}`,
  ])
}

