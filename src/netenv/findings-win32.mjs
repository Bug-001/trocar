// findings-win32.mjs (src/netenv) — the Windows half of `doctor`'s catalogue (RFC 4.8 §10.4, the kernel-era rows retired with the kernel — D47's twin: the forwarder-* family and the fallback verdict
// have no producer on any arch now, and the engine's per-group doors are the only local proxy): the commands of 1.6 §9.6's codes on Windows, one entry per code row of the §10.4 table, every value
// filled from the facts (a value that could not be read says 「不知道 · <原因>」, never a `<…>` placeholder). `src/netenv/findings.mjs` picks an entry from here first on win32; a field an entry leaves
// out falls back to the cross-platform catalogue's, and an entry for a code the cross-platform catalogue does not have (`form-unsupported`, `engine-port-taken`,
// `socktable-unavailable`) defines every field itself. `not-routed` splits by the `why` the group's plan gave (`system-proxy-pac` · `system-proxy-unreadable` · `upstream-unparseable`, whose
// `credentials-in-system-proxy` detail says WinINET takes no login from that value); `upstream-protocol` has no row of its own — it is the `proxy-unsupported` row. Nothing here runs anything (R8)
// and nothing here changes a system setting. `Get-NetTCPConnection` never appears — a restricted token is refused it (4.8 E6) — the port check is always `netstat -ano -p TCP | findstr
// ":<port>"`. A JSON edit is a `gui` step worded as 记事本 (a PowerShell one-liner would reorder the user's JSON).

const asight = (c, run) => ({ run, shell: c.sh })
const ps = (run) => ({ run, shell: 'powershell' })
const gui = (run) => ({ run, shell: 'gui' })
const unknownValue = (what, reason) => `不知道 · ${reason}(${what})`
/** The port check (4.8 §10.4: the one form, `netstat -ano -p TCP | findstr ":<端口>"`). */
const netstat = (port) => (Number.isInteger(port) ? ps(`netstat -ano -p TCP | findstr ":${port}"`) : gui(`netstat -ano -p TCP 加 findstr 加端口号(端口号读不到,asight status 里有)`))
const REG_QUERY_PROXY = 'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable'
const GET_PAC = "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name AutoConfigURL"

/** The `why` of a not-routed form: the group's plan's own (`fm.route`), else derived from what the facts carry (the form's OS proxy: a PAC, or a read that failed; the form's own setting that would
 *  not parse) — said the same way the plan says it. `{ why: null }` when neither knows (the generic text then). */
function whyOf(c) {
  const r = c.fm && c.fm.route
  if (r && r.why) return r
  const sys = (c.fm && c.fm.systemProxy) || (c.hf && c.hf.systemProxy) || null
  if (sys && sys.unknown) return { why: 'system-proxy-unreadable', detail: sys.unknown.reason }
  if (c.pac || (sys && sys.pac)) return { why: 'system-proxy-pac' }
  if (c.fm && c.fm.setting && c.fm.setting.unknown && c.fm.setting.unknown.reason === 'unparseable') return { why: 'upstream-unparseable' }
  return { why: null }
}

/** The 「把 <h> 的代理设成 <value>」 step of the not-routed rows (4.8 §10.4 row 1: 按 harness 文件的 `proxyEntry` 生成,值已填), from the form's group's entry place as the facts carry it
 *  (`entryPlace`): a JSON file is opened in 记事本 and its key written (never a PowerShell line that would reorder the user's JSON), a dotenv file gets its line, the policy value and the app's
 *  setting name their place; a shim or a launcher has no place of the user's own to write a proxy in — said, not invented. */
function setProxyText(h, place, value) {
  if (!place) return `把 ${h} 的代理设成 ${value}(这个形态的入口位置读不到)`
  if (place.kind === 'file') return place.format === 'json' ? `用记事本打开 ${place.file},把 ${place.key} 写成 "${value}"` : `${place.file} 里写一行 ${place.key}=${value}`
  if (place.kind === 'policy') return `在注册表策略 ${place.path} 里把 ${place.name} 写成 ${value}(regedit)`
  if (place.kind === 'shim') return `${place.command} 的代理入口是 asight 的 shim(${place.command}.cmd 设 HTTPS_PROXY):没有你可以改的自己的代理项`
  if (place.kind === 'launcher') return '这个形态的代理入口是 asight 的启动器:没有你可以改的自己的代理项(不经它启动的连接 asight 不在路径上)'
  return `把 ${h} 的代理设成 ${value}`
}

/** The catalogue (4.8 §10.4, one entry per code row). Commands only, unless the Windows row says its own thing about what or why. */
export const FINDINGS_WIN32 = {
  'not-routed': {
    cls: 'failure', asightFirst: false,
    what: (c) => `${c.h}${c.fm && c.fm.id ? ` 的形态 ${c.fm.id}` : ''} 的新连接不经过 asight`,
    why: (c) => { const w = whyOf(c)
      if (w.why === 'system-proxy-pac') return '这个形态跟随的系统代理是 PAC,asight 不执行 PAC,所以没接这个形态'
      if (w.why === 'system-proxy-unreadable') return `助手这一次没读到系统代理(${w.detail || '原因读不到'}),asight 不猜它是不是开着,所以没接这个形态(on 之后读不到的是提示,不是失败:留在上一次的上游)`
      if (w.why === 'upstream-unparseable') return w.detail === 'credentials-in-system-proxy'
        ? '系统代理的 ProxyServer 里带了用户名口令,WinINET 本来就不从这个值取凭据,asight 不照读,所以没接这个形态'
        : '这个形态原来的代理值 asight 读不懂,所以没接这个形态(asight status 印出它的入口文件与那一行,值里的用户名与口令打码)'
      return '这个形态没有 asight 能用的入口' // 1.6 §9.6's own words, for the case none of the whys above says
    },
    commands: (c) => { const w = whyOf(c)
      if (!w.why) return [gui(`${c.h} 的这个形态没有入口:改用它的 CLI 形态`), asight(c, `asight status ${c.h}`)]
      if (w.why === 'system-proxy-pac') return [gui(`在你的代理软件里看它的本地端口,把 ${c.h} 的代理设成它:${setProxyText(c.h, c.fm && c.fm.entryPlace, unknownValue('你的代理地址', 'pac'))}`), asight(c, `asight on ${c.h}`)]
      if (w.why === 'system-proxy-unreadable') return [asight(c, `asight on ${c.h}`), asight(c, `asight doctor ${c.h}`), ps(REG_QUERY_PROXY)]
      return [
        gui(w.detail === 'credentials-in-system-proxy' ? '在系统代理设置里把用户名口令从代理地址里去掉(WinINET 本来就不取它们);要凭据的代理写进这个 agent 自己的代理设置:' : '把它改成一个 asight 读得懂的写法(http://host:port 或 socks5://host:port):'),
        gui(setProxyText(c.h, c.fm && c.fm.entryPlace, unknownValue('你的代理地址', 'absent'))),
        asight(c, `asight on ${c.h}`), asight(c, `asight off ${c.h}`), // 不想改就 off,不采它
      ]
    },
    verify: (c) => `asight status ${c.h}:那一支「在路径上 · 是」`,
  },
  'opt-in-needed': {
    why: () => '它的入口改的东西影响超出这个 agent(§1.7);点名时 asight 先印「影响」,你确认了才做',
    commands: (c) => [asight(c, c.enable || `asight on ${c.h} --opt-in ${c.form || c.h}`)],
    verify: (c) => `asight status ${c.h}:该支「是」`,
  },
  'shim-not-on-path': {
    commands: (c) => {
      const command = c.fm && c.fm.entryPlace && c.fm.entryPlace.command
      return [...(command ? [ps(`where.exe ${command}`)] : []), asight(c, c.enable || `asight on ${c.h} --opt-in ${c.form || c.h}`), gui('或卸掉机器级的那一份,改用用户级安装')]
    },
    verify: (c) => (c.fm && c.fm.entryPlace && c.fm.entryPlace.command ? `where.exe ${c.fm.entryPlace.command} 第一个是 asight 的 shim` : `asight status ${c.h}`),
  },
  'not-via-entry': {
    commands: () => [gui('退出它,从开始菜单(asight 改过的快捷方式)或新开的终端启动'), gui('任务栏固定的:取消固定,再从开始菜单固定一次')],
    verify: (c) => `asight status ${c.h}:新 pid「是」`,
  },
  'entry-changed': { commands: (c) => [asight(c, `asight on ${c.h}`)], verify: (c) => `asight status ${c.h}` },
  'needs-admin': {
    commands: (c) => [gui('正常路径:asight 先确认、再弹 UAC,你点「是」;没有提示可弹时才用下面那一整行,在你自己开的管理员 PowerShell 里跑'), ...(c.elevated ? [{ run: c.elevated, shell: c.sh }] : [])],
    verify: () => 'asight status:不再列',
  },
  'egress-differs': { commands: (c) => [asight(c, `asight off ${c.h}`)], verify: () => '—' },
  'elevated-agent': {
    commands: (c) => [gui(`关掉它,不用「以管理员身份运行」重新打开 ${c.h}`), ps('whoami /groups | findstr /i "Mandatory"')],
    verify: (c) => `asight status ${c.h}`,
  },
  'proxy-dead': {
    commands: (c) => [netstat(c.dead && c.dead.port), gui(`打开你的代理软件(它应该监听 ${c.dead ? `${c.dead.addr}:${c.dead.port}` : unknownValue('它的地址', 'absent')})`), gui('或者关掉指着它的系统代理')],
    verify: () => '同一条命令看到 LISTENING',
  },
  'upstream-unreachable': {
    commands: (c) => [netstat(c.upPort), gui('打开你的代理软件,或关掉指着它的系统代理')],
    verify: (c) => `asight status ${c.h}:那一跳有属主`,
  },
  'engine-port-taken': {
    cls: 'failure', asightFirst: false,
    what: () => '引擎的入口端口被别的进程占了',
    why: () => '这扇门因此开不了;asight off 再 asight on 会重选端口',
    commands: (c) => [netstat(c.enginePort), asight(c, 'asight off'), asight(c, 'asight on')],
    verify: () => 'asight status:引擎「在跑」',
  },
  'forwarder-down': {
    commands: (c) => [asight(c, 'asight on'), asight(c, `asight off ${c.h}`), gui(`马上要用:上一步之后重启 ${c.h},它就不经 asight 了`)],
    verify: () => 'asight status:引擎「在跑」',
  },
  'form-unsupported': {
    cls: 'failure', asightFirst: false,
    what: (c) => `${c.h}${c.fm && c.fm.id ? ` 的形态 ${c.fm.id}` : ''} 收不了带凭据的上游`,
    why: () => '它的入口没有口令(免鉴权的端口),asight 不把带用户名口令的代理接给它',
    commands: (c) => [gui(`改用 ${c.h} 的 CLI 或编辑器扩展形态`)],
    verify: () => '—',
  },
  'proxy-unsupported': {
    what: (c) => `${c.h} 的代理协议接不上(${c.protocol || (c.setting && c.setting.scheme) || '不知道是哪一个'})`,
    why: (c) => (c.protocol ? `这个形态原来的代理是 ${c.protocol} 的,asight 的上游还不支持,on 因此不接这个形态` : `${c.h} 不支持 ${c.setting && c.setting.scheme}(它自己的代理设置里配的)`),
    commands: (c) => [gui('把它改成 http://host:port 或 socks5://host:port 的写法'), gui(setProxyText(c.h, c.fm && c.fm.entryPlace, unknownValue('你的代理地址', 'absent'))), asight(c, `asight on ${c.h}`), asight(c, `asight off ${c.h}`)],
    verify: (c) => `asight status ${c.h}:那一支「在路径上 · 是」`,
  },
  'system-proxy-pac': { commands: () => [ps(GET_PAC)], verify: () => '—' },
  'other-redirector': { commands: () => [ps('netsh winsock show catalog')], verify: () => '—' },
  'socktable-unavailable': {
    cls: 'failure', asightFirst: false,
    what: () => '连接属主的套接字表读不到,这条连接不经采集只转发',
    why: () => 'asight 宁可不知道也不猜属主;属主读不到的连接被旁路(splice),不采也不断',
    commands: () => [gui('无需操作:这条连接只转发不采集;新的连接会再问一次')],
    verify: () => '—',
  },
  'cause-unknown': {
    commands: (c) => [asight(c, `asight off ${c.h}`), gui(`再试 ${c.h}:仍连不上 → 与 asight 无关`)],
    verify: (c) => `再试 ${c.h}`,
  },
}
