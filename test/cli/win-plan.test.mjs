// test/cli/win-plan.test.mjs — the plan `asight on` prints on Windows (4.8 §11, plan Task 10(c)): the kernel line, one row per automatic entry group with the upstream
// the kernel will dial (the 「读不到你终端里的 HTTPS_PROXY」 note on the §2.2 rule-2/-3 cells — the agent's own prior needs no note, the system proxy and the direct
// fallback do), Codex's WebSocket line, the 「要你点名的」 section with one 影响 per item, Smart App Control, the off exception, and 「asight 不会」 — and NOT the
// per-process VPN line (V45: that one is `status <h>`'s; a plan says what `on` will do). A kernel that is missing or fails its pinned digest is the WHOLE plan (§11's
// second block): `on` stops before its first write. Everything runs in the win-on-ctx sandbox — the real arch hooks, the real facts behind an injected helper, a fake
// daemon — with the system proxy on, so the rows show both §2.2 rules the plan's example shows (claude-code direct, codex through the system proxy).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { winWorld } from './fixtures/win-on-ctx.mjs'

const SYSPROXY = { ProxyEnable: { kind: 'REG_DWORD', value: 1 }, ProxyServer: { kind: 'REG_SZ', value: '127.0.0.1:7897' } }
const squash = (s) => String(s).replace(/\s+/g, '')
/** the §11 plan of this world, written out literally (the kernel verified, the system proxy on, the seven harnesses' files, every opt-in item still to name) */
const PLAN = `asight 要做的(本用户,不需要管理员):
  自带内核  %USERPROFILE%\\.asight\\collector\\kernel\\asight-forwarder.exe(mihomo v1.19.32;已就位,sha256 已核对;只听 127.0.0.1,不开 TUN,不当系统代理)
  asight 自己建或改的:
    install manifest: %USERPROFILE%\\.asight\\collector\\install-manifest.json
    asight-off, the undo that works without the source tree or the daemon: %USERPROFILE%\\.asight\\bin\\asight-off
    collector CA (in no trust store): %USERPROFILE%\\.asight\\collector\\ca\\ca.key, %USERPROFILE%\\.asight\\collector\\ca\\asight-ca.pem
    codex: %USERPROFILE%\\.asight\\collector\\ca\\combined-codex.pem = the collector CA
    hermes: %USERPROFILE%\\.asight\\collector\\ca\\combined-hermes.pem = the collector CA
    z-code: %USERPROFILE%\\.asight\\collector\\ca\\combined-z-code.pem = the collector CA
    runtime directory (the plugins' trust markers): %USERPROFILE%\\.asight\\collector\\run\\trust/
    deepseek-dsh: %USERPROFILE%\\.dsh\\asight-ca.mjs (asight's plugin)
    opencode: %USERPROFILE%\\.config\\opencode\\plugins\\asight-ca.js (asight's plugin)
    backups, a copy of each of those files that exists, made before it is changed: %USERPROFILE%\\.asight\\backup/
    install notes (event log): %USERPROFILE%\\.asight\\collector\\flows/
    opencode itself may write %USERPROFILE%\\.config\\opencode\\package.json (OpenCode installs @opencode-ai/plugin there on its first run with any plugin); uninstall reports it, never deletes it
    opencode itself may write %USERPROFILE%\\.config\\opencode\\package-lock.json (OpenCode installs @opencode-ai/plugin there on its first run with any plugin); uninstall reports it, never deletes it
    opencode itself may write %USERPROFILE%\\.config\\opencode\\bun.lock (OpenCode installs @opencode-ai/plugin there on its first run with any plugin); uninstall reports it, never deletes it
    opencode itself may write %USERPROFILE%\\.config\\opencode\\node_modules (OpenCode installs @opencode-ai/plugin there on its first run with any plugin); uninstall reports it, never deletes it
  各形态(代理入口与信任入口;只改 agent 自己的文件,原值记下,off 时还原)
  claude-code.cli · claude-code.vscode  %USERPROFILE%\\.claude\\settings.json  env.HTTPS_PROXY · env.NODE_EXTRA_CA_CERTS  上游: 直连(读不到你终端里的 HTTPS_PROXY)
  codex.cli · codex.vscode · codex.app  %USERPROFILE%\\.codex\\.env  顶部 asight 哨兵块  上游: 系统代理 127.0.0.1:7897(读不到你终端里的 HTTPS_PROXY)
      WebSocket 原本直连,之后也经系统代理
  deepseek-dsh.cli · deepseek-dsh.desktop  %USERPROFILE%\\.dsh\\.env  顶部 asight 哨兵块  上游: 直连(读不到你终端里的 HTTPS_PROXY)
      %USERPROFILE%\\.dsh\\cordis.patch.yml line "- insert: [{id: asight-ca, name: ./asight-ca.mjs}] # asight collector: loads asight's CA trust plugin (\`asight collector uninstall\` removes this line)"
  hermes.cli  %LOCALAPPDATA%\\hermes\\.env  顶部 asight 哨兵块  上游: 系统代理 127.0.0.1:7897(读不到你终端里的 HTTPS_PROXY)
  z-code.cli  %USERPROFILE%\\.zcode\\cli\\config.json  network.httpProxy · network.caCertFile  上游: 直连(读不到你终端里的 HTTPS_PROXY)
  (标「读不到你终端里的 HTTPS_PROXY」的形态:你若在终端里设了代理再从那个终端起它,它原本走的是那个代理)
  要你点名的(默认不做;点名: asight on <harness> --opt-in <形态>)
    claude-code.desktop  cert-store-current-user    影响: asight's CA is installed in your certificate store (CurrentUser\\Root), so all your programs trust it, and its private key can be read by your own processes; Windows asks you to confirm. The policy value only affects Claude Desktop
    kimi-code.cli  user-path-shim    影响: the order of the PATH every one of your programs sees changes (asight's shim directory first); only commands named like the shim (\`kimi\`) resolve to it
    kimi-code.cli  machine-path-dispatcher(要管理员)    影响: needs administrator rights, which you give in the step asight shows: a directory only SYSTEM and Administrators can write goes first on the machine PATH, for all users; its dispatcher runs asight's shim only for you and the real binary for everyone else
    kimi-code.vscode  vscode-settings-and-launcher    影响: every extension of VS Code sends its connections through asight's kernel: only those to Kimi's hosts (the defaults, the relay in Kimi's own settings, and your extra_hosts) are decrypted and recorded, the rest are forwarded untouched; no extension reads the system roots any more; VS Code is started through an asight launcher
    opencode.cli  user-path-shim    影响: the order of the PATH every one of your programs sees changes (asight's shim directory first); only commands named like the shim (\`opencode\`) resolve to it
    opencode.cli  machine-path-dispatcher(要管理员)    影响: needs administrator rights, which you give in the step asight shows: a directory only SYSTEM and Administrators can write goes first on the machine PATH, for all users; its dispatcher runs asight's shim only for you and the real binary for everyone else
    opencode.desktop  start-menu-launcher    影响: your Start-menu and desktop shortcuts for OpenCode start it through an asight launcher; the taskbar pin, start at login and deep links do not go through it
    opencode.desktop  all-users-launcher(要管理员)    影响: needs administrator rights: the all-users shortcuts point at a launcher in a directory only SYSTEM and Administrators can write
    z-code.desktop  zcode-app-settings    影响: the whole Z-Code Desktop app (shell, renderers, the embedded browser) sends its connections through asight's kernel, where they are decrypted and recorded, and trusts asight's CA; this is the app's own settings file, nothing outside it
  Smart App Control: 关(只读;开着时未签名的内核很可能起不来)
  自启: 计划任务 \\asight\\collector(本用户,登录时)
  跳过: kimi-code(no kimi-code configuration was found on this machine: nothing to change for it)
  注意: on 期间启动的 agent,off 之后、重启之前仍经 asight 的内核(只转发)
本机网络环境: 不知道(a test: no VPN probe runs here)
asight 不会: 开 TUN、改系统代理、往你的 VPN 里写东西、往登录环境写代理变量`

test('§11: on --dry-run prints the plan — the kernel line, every automatic group with its upstream and the §2.2 note, Codex\'s WebSocket line, Smart App Control, autostart, the off exception — line by line (squashed)', async () => {
  const w = winWorld({ internet: SYSPROXY })
  const r = await w.run(['--dry-run'])
  assert.equal(r.exit, 0)
  const lines = r.stdout().split('\n\n')[0].split('\n') // the plan; the receipt follows after the blank line
  assert.deepEqual(lines.map(squash), PLAN.split('\n').map(squash), 'the §11 plan, line by line')
})

test('§11: the plan\'s rows carry the three things the task names apart from the golden block — one 影响 per offered item, NOT the per-process VPN line (V45), and the shell-proxy note when the terminal itself has one', async () => {
  const w = winWorld({ internet: SYSPROXY })
  const plain = (await w.run(['--dry-run'])).stdout().split('\n\n')[0].split('\n')
  const from = plain.findIndex((l) => l.includes('要你点名的')), to = plain.findIndex((l) => l.includes('Smart App Control'))
  assert.ok(from > 0 && to > from)
  assert.equal(to - from - 1, 9, 'nine offered items in 4.8 §2.4\'s order')
  for (const l of plain.slice(from + 1, to)) assert.match(l, /影响: /, 'one 影响 per offered item')
  assert.ok(!plain.some((l) => /按进程分流/.test(l)), 'V45: the per-process VPN line is status\'s, not the plan\'s')
  assert.ok(!plain.some((l) => /值打码/.test(l)), 'no shell-proxy note without a shell proxy')
  const shell = (await w.run(['--dry-run'], { env: { HTTPS_PROXY: 'http://shell.proxy:8080' } })).stdout().split('\n\n')[0].split('\n')
  assert.ok(shell.some((l) => squash(l) === squash('(这个终端里设了 HTTPS_PROXY(值打码):agent 若从这个终端起,它的上游可能不是下面写的)')), '§2.2 rule 1\'s note names the shell\'s own variable')
})

// the flip (plan Task 9(b), 1.6 §4 / §2) settled into the only path there is (D39⑥ executed 2026-10-11: the legacy-on dispatch went with the old capture):
// `on` with platform win32 runs the win32 arch's own §11 plan. The same winWorld seam as the plan tests above, only the CLI's platform is win32.
test('`on` with platform win32 runs the new collector — the win32 arch hooks are asked and the §11 plan is drawn', async () => {
  const w = winWorld()
  const r = await w.run(['--dry-run'], { platform: 'win32' })
  assert.equal(r.exit, 0, r.text)
  assert.match(r.stdout(), /^asight 要做的/, 'the §11 plan of the NEW collector is what win32 gets')
  assert.match(r.stdout(), /自带内核/, 'drawn from the win32 arch\'s own prepare answer (the kernel line)')
})

test('§11: a named opt-in item moves out of 「要你点名的」 into the plan\'s own changes (「你点名的(这次做,off 时一起撤掉)」), its 影响 carried along', async () => {
  const w = winWorld({ internet: SYSPROXY })
  const r = await w.run(['--dry-run', '--opt-in', 'kimi-code.vscode'])
  assert.equal(r.exit, 0)
  const plan = r.stdout().split('\n\n')[0]
  const chosen = plan.split('\n').filter((l) => l.includes('你点名的(这次做'))
  assert.equal(chosen.length, 1, 'the section exists once')
  assert.match(plan.split('\n')[plan.split('\n').indexOf(chosen[0]) + 1], /^    kimi-code\.vscode  vscode-settings-and-launcher    影响: /, 'the named item with its 影响, under the section head')
  assert.ok(!/    kimi-code\.vscode  vscode-settings-and-launcher/.test((plan.split('要你点名的(默认不做')[1] || '').split('Smart App Control')[0]), 'and the offered section no longer lists it')
})

test('§11: a kernel that is missing or fails its pinned digest is the WHOLE plan — the refusal line and the manual alternative, nothing else; a real `on` stops before its first write (exit 1, a failure event in flows/, no manifest)', async () => {
  const refuse = { reason: 'asight-forwarder.exe 的 sha256 与 mihomo-pin.json 不符', code: 'kernel-digest', commands: ['把 mihomo-windows-amd64-compatible-v1.19.32.zip 放进 %USERPROFILE%\\.asight\\collector\\kernel-archive\\ 再跑 asight on,或修好网络 / 代理(HTTPS_PROXY)后重跑'] }
  const w = winWorld({ prep: { refuse } })
  const dry = await w.run(['--dry-run'])
  assert.equal(dry.exit, 0)
  assert.deepEqual(dry.stdout().split('\n\n')[0].split('\n').map(squash), [
    'asight 要做的(本用户,不需要管理员):',
    '  自带内核  没拿到:下载失败或摘要不符(原因与手动替代见回执),所以 on 不开始',
    `    手动替代(asight 不替你跑):${refuse.commands.join(' 或 ')}`,
  ].map(squash), '§11\'s second block is the whole plan')
  assert.match(dry.stdout(), /\(a real asight on stops there\)/, 'the dry-run receipt says the stop a real run would meet (R6)')
  const real = await w.run(['--yes'])
  assert.equal(real.exit, 1, 'EXIT.incomplete: on stopped at the refusal')
  assert.ok(!fs.existsSync(path.join(w.dir, 'install-manifest.json')), 'nothing was written: the plan never ran')
  const flows = fs.readdirSync(path.join(w.dir, 'flows')).filter((f) => f.endsWith('.ndjson'))
  const events = flows.flatMap((f) => fs.readFileSync(path.join(w.dir, 'flows', f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  assert.ok(events.some((e) => e.event === 'failure' && e.where === 'forwarder' && e.code === 'kernel-digest'), 'the stop is on disk, not only in the receipt (D38)')
})

// D44 (4.8 §8 ① ⑥): the kernel is neither in `kernel\` nor in the cache → the plan's download line (version, the archive's size, the pinned sha256, the host),
// and the download itself happens only in the write phase of a REAL on — never in a dry run, never before the confirmation.
test('D44: the missing kernel is a download line in the plan — and the write-phase hook runs once, only in a real on (a dry run downloads nothing)', async () => {
  const prep = { notes: ['the kernel line'], kernel: { version: 'v1.19.32', exe: 'asight-forwarder.exe', sha256: '974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0', state: 'will-download', size: 22525067, url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.32/mihomo-windows-amd64-compatible-v1.19.32.zip', host: 'github.com' } }
  const calls = []
  const w = winWorld({ internet: SYSPROXY, prep, ensureKernel: async (a) => { calls.push(a); return { ok: true, path: 'kernel\\asight-forwarder.exe', sha256: 'a'.repeat(64), from: 'download', copied: true, note: 'the kernel was downloaded and both digests verified (sha256 aaaaaaaaaaaa…)' } } })
  const dry = await w.run(['--dry-run'])
  assert.equal(dry.exit, 0)
  const plan = dry.stdout().split('\n\n')[0].split('\n')
  assert.ok(plan.some((l) => squash(l) === squash('  自带内核  将下载内核 mihomo v1.19.32(压缩包 21.5 MB,sha256 钉死,来自 github.com),确认后开始')), 'the download line: version, the archive\'s size, the pinned sha256, the host (4.8 §8 ①)')
  assert.deepEqual(calls, [], 'a dry run downloads nothing (R6)')
  const real = await w.run(['--yes'])
  assert.equal(real.exit, 0, real.text)
  assert.equal(calls.length, 1, 'the write-phase hook ran exactly once (the CLI\'s one online step)')
  assert.equal(calls[0].home, w.home, 'with the home the on runs in')
  assert.match(real.stdout(), /the kernel was downloaded and both digests verified/, 'the receipt carries the download\'s own line (from the hook\'s note)')
})

// D44 (4.8 §8 ①): a failed download stops the on AFTER the confirmation and BEFORE any agent file — the sandbox HOME is byte-identical to what it was, and
// the unwritten receipt carries the reason with the manual alternative (the hook's own failure event is the wiring test's cell; here the hook is a fake).
test('D44: a failed download stops the on before any agent file — the world byte-identical, an unwritten receipt with the reason, nothing else written', async () => {
  const prep = { notes: ['the kernel line'], kernel: { version: 'v1.19.32', exe: 'asight-forwarder.exe', sha256: '974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0', state: 'will-download', size: 22525067, url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.32/mihomo-windows-amd64-compatible-v1.19.32.zip', host: 'github.com' } }
  const w = winWorld({ internet: SYSPROXY, prep, ensureKernel: async () => ({ ok: false, reason: 'the download of mihomo-windows-amd64-compatible-v1.19.32.zip failed (curl: exit 22); nothing was changed. 手动替代(asight 不替你跑): 把 mihomo-windows-amd64-compatible-v1.19.32.zip 放进 %USERPROFILE%\\.asight\\collector\\kernel-archive\\ 再跑 asight on,或修好网络 / 代理(HTTPS_PROXY)后重跑' }) })
  const before = snapshot(w.home)
  const r = await w.run(['--yes', '--json'])
  assert.equal(r.exit, 1, 'EXIT.incomplete: on stopped at the failed download')
  assert.deepEqual(snapshot(w.home), before, 'a failed download writes nothing: not one agent file, not even the collector\'s own (the receipt is the record)')
  const doc = r.json()
  assert.equal(doc.ok, false)
  assert.deepEqual(doc.changed, [], 'unwritten receipt: no change listed')
  assert.match(doc.notes.join('\n'), /curl: exit 22/, 'the failure\'s reason rides in the receipt')
  assert.match(doc.notes.join('\n'), /手动替代\(asight 不替你跑\)/, 'with the manual alternative (W27 ⑤)')
})

/** every file and its bytes under the home — a refusal or a failed download must leave all of it untouched (W27 ⑥ / D44). */
function snapshot(home) {
  const out = []
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else out.push([path.relative(home, p), fs.readFileSync(p).toString('utf8')]) } }
  walk(home)
  return out
}
