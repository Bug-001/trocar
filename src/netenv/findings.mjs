// findings.mjs (src/netenv) — what `asight doctor` says about the network (RFC 1.6 §9.6): the catalogue of findings, one entry per code, and `diagnose`, which says which of them the facts and the topology call for.
// A finding is `{ code, class, harness?, what, why, commands: [{ run, shell }], verify }`. The commands are whole lines with every value filled in (pid, port, path, user): a value that could not be read is
// written 「不知道 · <原因>」 with the command that reads it, never a `<…>` placeholder. asight's own commands come first, then the application's or the OS's. Nothing here runs anything (R8): `doctor` only
// prints them. Pure: facts and topology in, findings out.
import { detectDrift } from './adopt.mjs'
import { hopKey, firstHopAfterAsight, firstHopOff } from './topology-text.mjs'
import { parseProxyUrl } from './redact.mjs'
import { trustReasonText } from '../collector/core/codes.mjs'
import { TRUST_REASONS, ROUTE_TRUST_REASONS } from '../health/codes.mjs'
import { FINDINGS_WIN32 } from './findings-win32.mjs'

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
/** The steps that make an agent read its settings again: the harness's own words (the application step), and, where the harness keeps its settings in a managed process its windows do not end (`restart.managed`),
 *  the command that ends it, with the pid the facts hold. A managed process that is not running has nothing to end. */
function restartSteps(ctx) {
  const r = (ctx.hf.behaviour && ctx.hf.behaviour.restart) || {}
  const steps = [gui(r.hint ? r.hint : `退出 ${ctx.h},再重新启动`)]
  if (r.managed === true && r.processes) {
    const name = r.processes.split(/\s+/).filter((t) => !t.startsWith('-')).join(' ') // `codex app-server --managed-daemon` → the name a process of it is listed under: `codex app-server`
    for (const p of ctx.hf.procs) if (p.name === name) steps.push(os(ctx, { linux: `kill ${p.pid}`, darwin: `kill ${p.pid}`, win32: `Stop-Process -Id ${p.pid}` }))
  }
  return steps
}
const settingOf = (hf) => (hf.setting && !hf.setting.unknown && hf.setting.value ? hf.setting : ((hf.forms || []).map((f) => f.setting).find((s) => s && s.value) || null))
const deadProxy = (t) => t.nodes.find((n) => n.kind === 'proxy' && n.down === true) || null

/** not-routed, by the reason the model's route plan gave the form (`fm.route.reason`, src/collector/core/proxymode/entries.mjs; 4.11 §3 ③ ⑦ ⑩ ㉑, 1.6 §9.6): the why, and the steps
 *  (the place the plan named in `at`, else 「不知道」). A PAC the facts see and no reason of the plan's is the PAC row; nothing known is the generic row. */
function notRoutedOf(c) {
  const r = (c.fm && c.fm.route) || {}, at = r.at || unknownValue('那一处', 'absent'), on = asight(c, `asight on ${c.h}`)
  if (r.reason === 'system-pac' || (!r.reason && c.pac)) return { why: '它跟随的系统代理是 PAC,asight 不执行 PAC', commands: [gui(`把 ${c.h} 的代理设成一个具体地址:${setAt(c.h, placeOf(c.hf, c.setting), unknownValue('你的代理地址', 'pac'))}`), on] }
  if (r.reason === 'blocker' || r.reason === 'own-egress') return { why: `你的一处设置让 ${c.h} 不走 asight 能接的入口(${at})`, commands: [gui(`删掉 ${at} 这一处设置`), on] }
  if (r.reason === 'blocker-unreadable' || r.reason === 'unreadable') return { why: `asight 读不出 ${at},不知道它会不会拦住采集,所以没接`, commands: [gui(`让 ${at} 可读(或改好它)`), on] }
  if (r.reason === 'absent') return { why: `${c.h} 的入口文件 ${at} 不在;asight 不新建它(建了会改变别处设置的优先级)`, commands: [gui(`先跑 ${c.h} 自己的设置,让它建出 ${at}`), on] }
  if (r.reason === 'credentialed-own-leg') return { why: '这个形态的入口没有口令,asight 不把带用户名口令的上游接给它', commands: [gui(`把 ${c.h} 的上游换成不带口令的代理,或改用它的 CLI 形态`), on] }
  if (r.reason === 'no-path' || r.reason === 'no-applied-entry') return { why: `asight 找不到 ${c.h} 这个形态的入口${r.at ? `(${r.at})` : ''}`, commands: [gui(`先启动一次 ${c.h},让它建出自己的设置`), on] }
  if (r.reason === 'no-carrier') return { why: '这个形态的证书还没装', commands: [asight(c, 'asight install'), on] }
  return { why: '这个形态没有 asight 能用的入口', commands: [gui(`${c.h} 的这个形态没有入口:改用它的 CLI 形态`), asight(c, `asight status ${c.h}`)] }
}

/** The catalogue. `applies` is `diagnose`'s business; each entry says what it is. `cls` is the class, or a function of the context where it depends (§9.6: `proxy-changed`). */
export const FINDINGS = {
  'desired-off': { cls: 'expected', asightFirst: true, what: (c) => `${c.h} 现在是关着的(期望态 off)`, why: () => '你(或 asight off)把它关了:asight 不在它的路径上,它直连或走自己的代理', commands: (c) => [asight(c, `asight on ${c.h}`)], verify: (c) => `asight status ${c.h}:被采集「是」` },
  'daemon-not-running': { cls: 'failure', asightFirst: true, what: () => '守护进程没在跑', why: () => '没有它就没有引擎,新连接不被采集(入口之外的驱动已随助手一起没了)', commands: (c) => [asight(c, `asight on ${c.h}`)], verify: () => 'asight status:守护进程「在跑」' },
  'daemon-not-responding': { cls: 'failure', asightFirst: true, what: () => '守护进程在跑但没响应', why: () => '心跳过期,新连接已因此直连;它卡住了', commands: (c) => [asight(c, 'asight off'), asight(c, `asight on ${c.h}`)], verify: () => 'asight status:守护进程「在跑」' },
  'helper-missing': { cls: 'failure', asightFirst: false, what: () => '能力助手缺失或版本不对', why: () => '没有它就挂不上内核里的驱动', commands: (c) => [{ run: 'sudo asight setup-helper', shell: 'sh' }, asight(c, `asight on ${c.h}`)], verify: () => 'asight status:link 已挂' },
  'link-missing': { cls: 'failure', asightFirst: true, what: () => '期望开,但内核里没有本实例的 link', why: () => '驱动没挂上,新连接直连', commands: (c) => [asight(c, `asight on ${c.h}`)], verify: () => 'asight status:link 已挂' },
  'entry-missing': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 的信任入口不在了`, why: () => '入口(asight 写进它配置的那一项)被删了或还没写', commands: (c) => [asight(c, `asight on ${c.h}`)], verify: (c) => `asight status ${c.h}:信任入口完好` },
  'entry-changed': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 的信任入口被改成了别的`, why: () => '你或别的程序改了 asight 写的那一项', commands: (c) => [asight(c, `asight off ${c.h}`), asight(c, `asight on ${c.h}`)], verify: (c) => `asight status ${c.h}:信任入口完好` },
  'negative-cache': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 的进程拒绝了 asight 的证书,那个 host 之后透传`, why: () => '这个形态不认 asight 的信任入口;(pid, host) 随进程记着', commands: (c) => [asight(c, `asight status ${c.h}`), ...restartSteps(c)], verify: (c) => `重启后 asight status ${c.h}:「是」` },
  'not-routed': { cls: 'failure', asightFirst: false, what: (c) => `${c.h} 的新连接不经过 asight`, why: (c) => notRoutedOf(c).why, commands: (c) => notRoutedOf(c).commands, verify: (c) => `asight status ${c.h}:该支「在路径上 · 是」` },
  'route-loop': { cls: 'failure', asightFirst: true, what: (c) => `${c.h} 的上游又是 asight 自己`, why: () => '算出的上游是 asight 自己的端口:代理字段的原值就是 asight 的门端口,或系统代理指着它;on 因此不接这个形态', commands: (c) => [asight(c, `asight off ${c.h}`), gui(`把 ${c.h} 的代理改回你原来的:${setAt(c.h, placeOf(c.hf, c.setting), c.old || unknownValue('原来的代理', 'absent'))}`), asight(c, `asight on ${c.h}`)], verify: () => 'asight doctor:不再报' },
  'proxy-dead': { cls: 'failure', asightFirst: false, what: (c) => `${c.h} 配的代理 ${c.dead.addr}:${c.dead.port} 没人在听`, why: () => '你的代理软件没开;这个设置不是 asight 写的',
    commands: (c) => [gui(`打开你的代理软件(它应该监听 ${c.dead.addr}:${c.dead.port})`), gui(`或者删掉这个设置:${c.setting ? removeAt(c.h, placeOf(c.hf, c.setting)) : unknownValue('这个设置', 'absent')}`), portCheck(c, c.dead.port)], verify: (c) => `同一条命令看到监听;asight status ${c.h} 那一跳有属主` },
  'proxy-unsupported': { cls: 'failure', asightFirst: false, what: (c) => `${c.h} 配了它不支持的代理协议(${c.setting.scheme})`, why: (c) => (c.silent ? `${c.h} 不支持 ${c.setting.scheme},会静默直连,代理形同虚设` : `${c.h} 不支持 ${c.setting.scheme}`),
    commands: (c) => [gui(`把它改成 HTTP 代理:${setAt(c.h, placeOf(c.hf, c.setting), c.setting.host && c.setting.port ? `http://${c.setting.host}:${c.setting.port}` : unknownValue('代理地址', 'absent'))}`)], verify: (c) => `asight status ${c.h}:那条边是 proxy-http` },
  'proxy-changed': { cls: (c) => (c.F.routing === 'proxy' ? 'failure' : 'expected'), asightFirst: true, what: (c) => `${c.h} 的代理设置与上次 on 接上的不同`, why: () => '你改了它',
    commands: (c) => (c.F.routing === 'proxy' ? [asight(c, `asight on ${c.h}`), asight(c, `asight off ${c.h}`)] : [gui(`无需操作:${c.h} 在跑的进程仍按启动时的设置,重启后按新设置走;新启动的进程照常被采`)]), verify: (c) => `asight status ${c.h}` },
  'elevated-agent': { cls: 'failure', asightFirst: false, what: (c) => `${c.h} 以管理员权限运行`, why: () => '提权的进程 asight 不解密(保守规则),只转发', commands: (c) => [gui(`关掉它,以普通权限重新启动 ${c.h}(不用「以管理员身份运行」)`)], verify: (c) => `asight status ${c.h}` },
  'forwarder-down': { cls: 'failure', asightFirst: true, what: () => 'asight 的本地代理(引擎的门)没在跑,入口指向它的 agent 连不上', why: () => '引擎死了或没起来;asight 的自启单元会把它拉起来', commands: (c) => [asight(c, 'asight on'), asight(c, `asight off ${c.h}`)], verify: () => 'asight status:引擎「在跑」' },
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
  // the name list (D51③⑤, 4.6 §识别进程): a process on no list used the harness's door (only forwarded), and agents.json's own problems. Not a WIDE name: the line to add, every value filled in;
  // an interpreter name needs args (its script), and asight does not keep command lines, so that line cannot be written (§9.6: no <…> left, an unknown value is said)
  // `named`: the name is listed, but only with args patterns its arguments missed; a bare line would claim every process of that name and undo them — none is given, like a WIDE name
  'process-unknown': { cls: 'hint', asightFirst: false, what: (c) => `名为 ${c.u.name ?? '(名字不知道)'} 的进程(pid ${c.u.pid ?? '不知道'})用了 ${c.h} 的入口,${c.u.named ? '名字在名单上、但参数没对上任何一项' : '不在名单上'},只转发`,
    why: (c) => (c.u.named ? 'asight 按进程名认 agent(D51);这个名字在名单上只带 args(参数模式),这个进程的参数一项都没对上' : 'asight 按进程名认 agent(D51);这个名字不在预设里,也不在你的 agents.json 里'),
    commands: (c) => [gui(c.u.name == null ? unknownValue('它的名字', '入口读不到这个进程的名字') : c.u.wide ? `解释器名要带 args(它的脚本名);asight 不记命令行,脚本名不知道:${c.u.name} 这一项要你自己在 ${c.listPath} 的 agents 里写,带上 "args"`
      : c.u.named ? `${c.u.name} 在名单上只带 args;不带 args 的整行会认领所有叫 ${c.u.name} 的进程,所以不给整行;asight 不记命令行,参数不知道:要采它,在 ${c.listPath} 的 agents 里自己写这一项,带上 "args"`
      : `把 ${JSON.stringify({ harness: c.h, name: c.u.name })} 加进 ${c.listPath} 的 agents(文件不在就新建为 {"version":1,"agents":[…]}),不用重启`)], verify: (c) => `asight status ${c.h}:该 pid 带上命中的名字` },
  'agent-list-invalid': { cls: 'failure', asightFirst: false, what: (c) => `${c.file.path} ${{ unreadable: '读不出', unparsable: '解析不了或版本不对' }[c.file.state] || '有坏项'}`, why: (c) => (c.file.state === 'ok' ? '坏项不生效,其余照用' : '整个文件不生效,只用预设的名字'),
    commands: (c) => c.file.problems.map((p) => gui(`${p.index == null ? `改好 ${c.file.path}` : `改好或删掉 ${c.file.path} 的第 ${p.index + 1} 项(agents[${p.index}])`}:${p.code} — ${p.detail};不用重启`)), verify: () => 'asight status:不再列' },
  // 4.11 §3 ⑱ / 1.6 §9.6: the issuer, the files install leaves alone, the forms and hosts not verified, the window's proxy that could not be recovered, and uninstall's refusal
  'cert-key-missing': { cls: 'failure', asightFirst: true, what: () => '根的密钥不在了,门只转发', why: () => '登录钥匙串里的密钥或 Windows 的 CNG 密钥被删了;守护进程每次启动核对', commands: (c) => [asight(c, 'asight install')], verify: () => 'asight status:密钥「在」' },
  'cert-intermediate-unavailable': { cls: 'failure', asightFirst: false, what: () => '签不出中间证书,门只转发', why: () => '没有图形登录会话(只有 ssh 登录)或钥匙串锁着;手里那张还没到期时照用,守护进程每小时重试',
    commands: (c) => [gui('在这台机器上登录图形会话、解锁钥匙串'), asight(c, 'asight status')], verify: () => 'asight status:中间证书「当前」' },
  'not-users-file': { cls: 'expected', asightFirst: false, what: (c) => `${c.h} 的设置指向的证书文件或程序不是你自己的,asight 没往里加`, why: () => 'install 只在你自己能写的文件末尾追加;包装只用于描述符写明 native-binary 的命令行',
    commands: (c) => [gui(`要采它:把 ${c.h} 的证书设置指向你自己的一份证书文件`), asight(c, 'asight install')], verify: (c) => `asight status ${c.h}:证书「生效」` },
  'not-verified': { cls: 'expected', asightFirst: false, what: (c) => `${c.h} 的这个形态,或它连的这个主机,还没在实验室验过信任,只转发`, why: () => 'asight 只解密验过的形态(D51④)',
    commands: (c) => [gui(`无需操作:${c.h} 照常工作,这些连接不经解密`)], verify: (c) => `asight status ${c.h}` },
  'prior-proxy-unknown': { cls: 'hint', asightFirst: false, what: (c) => `窗口里的代理没接上:${c.h}${c.pids && c.pids.length ? `(pid ${c.pids.join(', ')})` : ''}启动时的代理找不回,门改用系统代理,没有就直连`,
    why: () => '创建它的进程已退出,或中间隔着 Git Bash', commands: (c) => [gui(`要用窗口里的代理:把它写进 ${c.h} 自己的设置(${setAt(c.h, placeOf(c.hf, null), unknownValue('你的代理地址', 'env-unreadable'))})`), asight(c, `asight on ${c.h}`), gui(`重启 ${c.h}`)],
    verify: (c) => `asight status ${c.h}:上游的来源不是「不知道」` },
  'collectors-online': { cls: 'failure', asightFirst: true, what: (c) => `uninstall 拒绝:采集没有全部下线${c.online ? `(${c.online})` : ''}`, why: () => 'uninstall 从不代做 off', commands: (c) => [asight(c, 'asight off'), asight(c, 'asight uninstall')], verify: () => 'asight status:全部 off' },
  // The user named the harness (§9.1: the symptom is said by agent), and nothing in the facts explains it. asight has no fact that says an agent cannot connect, so this does not claim it: a condition, a hint.
  'cause-unknown': { cls: 'hint', asightFirst: true, what: (c) => `如果 ${c.h} 仍连不上:asight 这边没找到具体原因`, why: () => 'asight 读到的(期望态、进程、信任入口、代理设置)里没有哪一项能解释它;你点名了它,所以给出怎样把 asight 排除在外',
    commands: (c) => [asight(c, `asight off ${c.h}`), gui(`再试 ${c.h}:仍连不上 → 与 asight 无关;连得上 → ${`asight on ${c.h}`},再跑 asight doctor ${c.h} --json,并看看板「采集健康」里那段时间的失败`)], verify: (c) => `再试 ${c.h}:仍连不上 → 与 asight 无关` },
}
// the trust reasons not listed above (a variable missing, a file unreadable, …): the daemon's own hint says what to do about this agent
const TRUST = { cls: (c) => (RESTART_REASONS.includes(c.code) ? 'expected' : 'failure'), asightFirst: false, what: (c) => `${c.h} 的进程没被信任:${c.code}`, why: (c) => c.hint || trustReasonText(c.code) || '入口只在启动时读(§1.1);遮住的原因见 harness 的提示',
  commands: (c) => (RESTART_REASONS.includes(c.code) ? restartSteps(c) : [asight(c, `asight status ${c.h}`), gui(c.hint || trustReasonText(c.code) || `按 ${c.h} 的提示改`)]), verify: (c) => `asight status ${c.h}:新 pid「是」` }
/** Every code a finding may carry: the cross-platform catalogue's, the Windows table's (4.8 §10.4) and the trust reasons' — the Windows collector's own trust reasons (ROUTE_TRUST_REASONS, 4.8 §12) included,
 *  for the same reason TRUST_REASONS is: they are the codes of `agent-untrusted` a form's verdict can carry. The schema validates against this list. */
export const FINDING_CODES = Object.freeze([...new Set([...Object.keys(FINDINGS), ...Object.keys(FINDINGS_WIN32), ...TRUST_REASONS, ...ROUTE_TRUST_REASONS])])

// ── which of them the facts call for ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One finding: on win32 the Windows table (4.8 §10.4) takes precedence, field by field — an entry there may override only the commands (or the why), and one for a code the cross-platform catalogue
 *  does not have defines every field itself. A code neither catalogue names falls to the trust entry: the reasons the tracker can set are data, not caller bugs (the closed sets live in
 *  health/codes.mjs, held by its tests — a runtime throw here would take `doctor` down with a Windows state like `env-unreadable-fill`). */
function make(code, ctx) {
  const w = ctx.platform === 'win32' ? FINDINGS_WIN32[code] : null
  const def = FINDINGS[code] || TRUST
  const c = { ...ctx, code }
  const clsOf = (d) => (typeof d.cls === 'function' ? d.cls(c) : d.cls)
  const at = (f) => (w && w[f] ? w[f](c) : def[f](c))
  return { code, class: w && w.cls !== undefined ? clsOf(w) : clsOf(def), ...(ctx.h ? { harness: ctx.h } : {}), what: at('what'), why: at('why'), commands: at('commands'), verify: at('verify') }
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
    const optIn = (hf.forms || []).map((f) => f.optIn).find((o) => o && o.state !== 'done' && o.state !== 'unknown')
    const sysPac = !!((hf.systemProxy && hf.systemProxy.pac) || (hf.forms || []).some((f) => f.systemProxy && f.systemProxy.pac))
    const adminOpt = optIn && ['pending-admin', 'needs-admin'].includes(optIn.state)
    const upstream = Object.values((F.forwarder && F.forwarder.forms) || {}).map((x) => x.upstream).find((u) => u && u !== 'DIRECT')
    // the doctor's own name for a protocol the upstream cannot take replaces the branch's not-routed (4.8 §10.4: upstream-protocol sits on the proxy-unsupported row)
    const protoForm = (hf.forms || []).find((f) => f.route && f.route.code === 'proxy-unsupported') || null
    for (const r of reasons.filter((x) => !((adminOpt || (protoForm && x === 'not-routed')) && x === 'not-routed'))) add(r, { upPort: upstream ? (parseProxyUrl(upstream) || {}).port : undefined, hint: row && row.reason === r ? row.hint : undefined, pac: sysPac, enable: optIn && optIn.enable, form: optIn && optIn.form, fm: formOf(r) })
    if (protoForm) add('proxy-unsupported', { protocol: protoForm.route.protocol, fm: protoForm })
    if (adminOpt) add('needs-admin', { elevated: optIn.elevated })
    const dead = deadProxy(t)
    if (dead) add('proxy-dead', { dead })
    const s = base.setting
    if (s && s.scheme && ((hf.behaviour.unsupported || {})[s.scheme] || !(hf.behaviour.schemes || []).includes(s.scheme))) add('proxy-unsupported', { silent: (hf.behaviour.unsupported || {})[s.scheme] === 'silent-direct' })
    if (sysPac) add('system-proxy-pac')
    if (t.branches.some((b) => b.path.some((id) => (nodeOf(t, id) || {}).asight) && hopKey(firstHopAfterAsight(t, b)) !== hopKey(firstHopOff(t, b)) && firstHopAfterAsight(t, b))) add('egress-differs')
    // drift is what the user changed in the files, not what this shell happens to export; and a harness that is off has no drift to report (asight is not on its path)
    const drifts = F.desired[h] === 'off' ? [] : detectDrift({ adopted, h, setting: hf.fileSetting || hf.setting, routing: F.routing, scope: 'files' })
    if (F.routing === 'driver' && drifts.some((d) => d.code === 'proxy-changed')) add('proxy-changed')
    for (const fm of hf.forms || []) { const fwf = F.forwarder && F.forwarder.forms && F.forwarder.forms[fm.id]; if (fwf && fwf.source === 'unknown') add('prior-proxy-unknown', { pids: fm.procs.map((p) => p.pid) }) }
    if (hf.fakeIp === true) add('fake-ip')
    if (inferred(F, hf)) add('inferred-behaviour')
    const listPath = F.agentList ? F.agentList.path : null
    for (const u of (F.identity && F.identity[h] && F.identity[h].unknown) || []) found.set(`process-unknown\u0000${u.name}`, make('process-unknown', { ...base, u, listPath }))
    if (named && F.desired[h] === 'on' && hf.installed !== false && ![...found.values()].some((f) => f.class !== 'hint')) add('cause-unknown') // a failure or an expected finding already says why; only hints (about the data) leave it open
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

/** The findings as lines for a person: what, why, then each command on a line of its own with its shell, and how to check. */
export function renderFindings(findings) {
  const CLASS = { failure: '失败', expected: '预期', hint: '提示' }
  return findings.flatMap((f) => [
    `[${CLASS[f.class]}] ${f.harness ? `${f.harness} · ` : ''}${f.code} — ${f.what}`, `  为什么: ${f.why}`,
    ...f.commands.map((c, i) => `  ${i === 0 ? '怎么做:' : '       '} ${c.shell === 'gui' ? c.run : `$ ${c.run}`}${c.shell === 'powershell' ? '  (PowerShell)' : ''}`), `  怎么验证: ${f.verify}`,
  ])
}

