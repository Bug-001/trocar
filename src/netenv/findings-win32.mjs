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
const unknownValue = (what, reason) => `unknown ${what} (${reason})`
/** The port check (4.8 §10.4: the one form, `netstat -ano -p TCP | findstr ":<端口>"`). */
const netstat = (port) => (Number.isInteger(port) ? ps(`netstat -ano -p TCP | findstr ":${port}"`) : gui('Run netstat -ano -p TCP and look for the port; asight status prints it'))
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
 *  setting name their place (the shim and launcher places went with D52 / D57: mac / win write no shim or launcher). */
function setProxyText(h, place, value) {
  if (!place) return `Set ${h}'s proxy to ${value}`
  if (place.kind === 'file') return place.format === 'json' ? `Open ${place.file} in Notepad and set ${place.key} to "${value}"` : `Put the line ${place.key}=${value} in ${place.file}`
  if (place.kind === 'policy') return `Set ${place.name} under ${place.path} to ${value} (regedit)`
  return `Set ${h}'s proxy to ${value}`
}

/** The catalogue (4.8 §10.4, one entry per code row). Commands only, unless the Windows row says its own thing about what or why. */
export const FINDINGS_WIN32 = {
  'not-routed': {
    cls: 'problem', asightFirst: false,
    what: (c) => `New connections from ${c.h}${c.fm && c.fm.id ? ` (${c.fm.id})` : ''} do not go through asight.`,
    why: (c) => { const w = whyOf(c)
      if (w.why === 'system-proxy-pac') return 'The system proxy this form follows is a PAC script, which asight does not run.'
      if (w.why === 'system-proxy-unreadable') return `Your system proxy could not be read (${w.detail || 'no reason given'}), and asight does not guess, so it did not connect this form.`
      if (w.why === 'upstream-unparseable') return w.detail === 'credentials-in-system-proxy'
        ? 'Your system proxy address carries a login, which Windows itself does not use, so asight did not connect this form.'
        : 'asight cannot read the proxy address this form had, so it did not connect it.'
      return 'This form has no entry asight can use.'
    },
    commands: (c) => { const w = whyOf(c)
      if (!w.why) return [gui(`Use ${c.h}'s CLI form instead`), asight(c, `asight status ${c.h}`)]
      if (w.why === 'system-proxy-pac') return [gui(setProxyText(c.h, c.fm && c.fm.entryPlace, unknownValue('proxy address', 'pac'))), asight(c, `asight on ${c.h}`)]
      if (w.why === 'system-proxy-unreadable') return [asight(c, `asight on ${c.h}`), asight(c, `asight doctor ${c.h}`), ps(REG_QUERY_PROXY)]
      return [
        gui(w.detail === 'credentials-in-system-proxy' ? 'Take the login out of your system proxy address' : 'Write it as http://host:port or socks5://host:port'),
        gui(setProxyText(c.h, c.fm && c.fm.entryPlace, unknownValue('proxy address', 'absent'))),
        asight(c, `asight on ${c.h}`), asight(c, `asight off ${c.h}`),
      ]
    },
    verify: (c) => `asight status ${c.h}`,
  },
  'entry-changed': { commands: (c) => [asight(c, (c.fm && c.fm.certificate && c.fm.certificate.command) || `asight on ${c.h}`)], verify: (c) => `asight status ${c.h}` }, // a drifted install item (row 31) names its own command
  'egress-differs': { commands: (c) => [asight(c, `asight off ${c.h}`)], verify: (c) => `asight status ${c.h}` },
  'elevated-agent': {
    commands: (c) => [gui(`Quit ${c.h} and start it again without administrator rights`), ps('whoami /groups | findstr /i "Mandatory"')],
    verify: (c) => `asight status ${c.h}`,
  },
  'proxy-dead': {
    commands: (c) => [netstat(c.dead && c.dead.port), gui(`Start your proxy, so that it listens on ${c.dead ? `${c.dead.addr}:${c.dead.port}` : unknownValue('address', 'absent')}`), gui('Or turn off the system proxy that points at it')],
    verify: (c) => `asight status ${c.h}`,
  },
  'upstream-unreachable': {
    commands: (c) => [netstat(c.upPort), gui('Start your proxy, or turn off the system proxy that points at it')],
    verify: (c) => `asight status ${c.h}`,
  },
  'engine-port-taken': {
    cls: 'problem', asightFirst: false,
    what: () => 'Another program holds the port asight listens on, so nothing is captured.',
    why: () => 'asight picks another port after a restart.',
    commands: (c) => [netstat(c.enginePort), asight(c, 'asight off'), asight(c, 'asight on')],
    verify: () => 'asight status',
  },
  'forwarder-down': {
    commands: (c) => [asight(c, 'asight on'), asight(c, `asight off ${c.h}`), gui(`Restart ${c.h} after that, and it connects without asight`)],
    verify: () => 'asight status',
  },
  'form-unsupported': {
    cls: 'problem', asightFirst: false,
    what: (c) => `${c.h}${c.fm && c.fm.id ? ` (${c.fm.id})` : ''} cannot take an upstream proxy that needs a login.`,
    why: () => 'Its entry takes no login, so asight does not hand it one.',
    commands: (c) => [gui(`Use ${c.h}'s CLI form or its editor extension instead`)],
    verify: (c) => `asight status ${c.h}`,
  },
  'proxy-unsupported': {
    what: (c) => `${c.h} does not support the proxy scheme ${c.protocol || (c.setting && c.setting.scheme) || unknownValue('scheme', 'unreadable')}.`,
    why: (c) => (c.protocol ? `asight cannot use a ${c.protocol} proxy as its upstream, so it did not connect this form.` : `${c.h} cannot use the proxy scheme set in its own settings.`),
    commands: (c) => [gui('Write it as http://host:port or socks5://host:port'), gui(setProxyText(c.h, c.fm && c.fm.entryPlace, unknownValue('proxy address', 'absent'))), asight(c, `asight on ${c.h}`), asight(c, `asight off ${c.h}`)],
    verify: (c) => `asight status ${c.h}`,
  },
  'system-proxy-pac': { commands: () => [ps(GET_PAC)], verify: () => 'asight status' },
  'other-redirector': { commands: () => [ps('netsh winsock show catalog')], verify: () => 'asight status' },
  'socktable-unavailable': {
    cls: 'problem', asightFirst: false,
    what: () => 'Windows did not say which program owns a connection, so it was forwarded only.',
    why: () => 'asight never guesses the owner of a connection; it forwards it instead of capturing it.',
    commands: () => [gui('No action needed: that connection was forwarded, not captured; the next one is asked again')],
    verify: () => 'asight status',
  },
  'cause-unknown': {
    commands: (c) => [asight(c, `asight off ${c.h}`), gui(`Try ${c.h} again: if it still fails, asight is not the cause`)],
    verify: (c) => `Try ${c.h} again`,
  },
}
