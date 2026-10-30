// test/helpers/proc-seeds.mjs — measured and specified process shapes of the harnesses, with the harness each one IS (or null: not an
// agent, or a helper the harness's exclude items drop). These are regression seeds, not rules (RFC 4.6 「按 harness」 table note, 0.1 §2): the
// expectation of each comes from a source independent of the name list it checks — the RFC row, a measurement
// on a real install, a design review of the shape, or an existing harness test's example — and `source` says which. test/helpers/proc-variants.mjs bends each one along
// the install axes; test/collector/identity-presets.test.mjs (T4) asserts the harness of every seed and variant.
//
// Shape: { os, exe, argv, cmdline?, cmdlineState?, env?, harness, source }. `argv` is the process's logical argv (what Linux /proc gives and
// what CommandLineToArgvW gives on Windows); `cmdline` is the raw command line where the source had one. The shapes of the samples taken from
// test/collector/harness/{darwin,win32}-forms.test.mjs (both retired) are copied, not imported.
const U = '/Users/u'
const W = String.raw`C:\Users\u`
const S46 = 'spec 4.6:132-138 (按 harness 预设名单)'
const DF = 'test/collector/harness/darwin-forms.test.mjs:24-145 at 839ee1e5 (retired with the macOS form tables)'
const WF = 'test/collector/harness/win32-forms.test.mjs:21-102 at 60c8d165 (retired with the Windows overlays; the forms now live in proxyMode.forms of the base descriptors)'
const P = 'RFC 4.6 name list (D51)'

const winCmd = (argv) => argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
const w = (exe, args, harness, source, more = {}) => { const argv = [exe, ...args]; return { os: 'win32', exe, argv, cmdline: winCmd(argv), harness, source, ...more } }
const d = (exe, args, harness, source, argv0 = exe) => ({ os: 'darwin', exe, argv: [argv0, ...args], cmdline: [argv0, ...args].join(' '), harness, source })
const l = (exe, argv, harness, source, env) => (env ? { os: 'linux', exe, argv, env, harness, source } : { os: 'linux', exe, argv, harness, source })

const HERMES_BOOT = "import hermes_bootstrap; import hermes_cli.main as m; m.run()"
const ZCJS = '/Applications/ZCode.app/Contents/Resources/app/resources/glm/zcode.cjs'
const NET = ['--type=utility', '--utility-sub-type=network.mojom.NetworkService']
const NODE = String.raw`C:\Program Files\nodejs\node.exe`
const PI_HOME = `${W}\\.pi\\agent`
const PI_CLI = String.raw`@earendil-works\pi-coding-agent\dist\bundle\cli.js`
const PIW = 'pi 1.4.0 on Windows (measured)'
const PIM = 'pi 1.4.0 on macOS (measured)'
const MNODE = '/opt/homebrew/bin/node'

export const SEEDS = [
  // ── claude-code ──
  d(`${U}/.local/share/claude/versions/2.1.296`, ['-p', 'hi'], 'claude-code', `${DF} (claude-code.native: the version-named file, a macOS machine 2026-10-12)`, 'claude'),
  d(`${U}/.local/share/claude/versions/2.1.289/claude`, [], 'claude-code', `${DF} (claude-code.native)`),
  d(`${U}/.local/bin/claude`, [], 'claude-code', `${DF} (claude-code.cli)`),
  d(`${U}/.nvm/versions/node/v22.20.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude`, [], 'claude-code', `${DF} (claude-code.cli)`),
  d(`${U}/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude`, [], 'claude-code', `${DF} (claude-code.vscode)`),
  d(`${U}/Library/Application Support/Claude/claude-code/2.1.296/abc123/claude.app/Contents/MacOS/claude`, ['-p', 'hi'], 'claude-code', `${P} mac claude-code F1 (Desktop-bundled Claude Code)`),
  d('/Applications/Claude.app/Contents/MacOS/Claude', [], 'claude-code', `${S46} (the Desktop main process is named claude; judged by the settings layer)`),
  d('/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper', NET, 'claude-code', `${S46} (claude helper + the Chromium network service args)`),
  d('/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)', ['--type=renderer'], null, `${S46} (Helper renderer / gpu do not count)`),
  d('/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper', ['--type=gpu-process'], null, `${S46} (Helper renderer / gpu do not count)`),
  l('/home/u/.local/share/claude/versions/2.1.296', ['claude', '-p', 'hi'], 'claude-code', 'test/collector/harness/claude-code.test.mjs:13'),
  l('/home/u/.local/share/claude/versions/2.1.296 (deleted)', ['claude'], 'claude-code', 'test/collector/harness/claude-code.test.mjs:14'),
  l('/home/u/.local/share/claude/versions/2.1.296', ['claude', '--daemon-worker', 'x'], 'claude-code', 'test/collector/harness/claude-code.test.mjs:15'),
  l('/home/u/.local/share/claude/versions/2.1.296', ['rg', '--files'], null, 'test/collector/harness/claude-code.test.mjs:16 (excluded)'),
  l('/home/u/.local/share/claude/versions/2.1.296', ['apply-seccomp', 'x'], null, 'test/collector/harness/claude-code.test.mjs:17 (excluded)'),
  l('/usr/bin/node', ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], null, 'test/collector/harness/claude-code.test.mjs:18'),
  w(`${W}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, [], 'claude-code', `${WF} (claude-code.cli)`),
  w(`${W}\\.local\\bin\\claude.exe`, [], 'claude-code', `${WF} (claude-code.cli)`),
  w(`${W}\\.vscode\\extensions\\anthropic.claude-code-2.1.289-win32-x64\\resources\\native-binary\\claude.exe`, [], 'claude-code', `${WF} (claude-code.vscode)`),
  w(`${W}\\AppData\\Local\\AnthropicClaude\\app-1.0.1307\\claude.exe`, NET, 'claude-code', `${P} win claude-code F1 (Squirrel app-<ver>\\claude.exe, network service)`),
  // ── codex ──
  d(`${U}/.nvm/versions/node/v22.20.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`, ['exec', 'hi'], 'codex', `${DF} (codex.cli)`),
  d(`${U}/.vscode/extensions/openai.chatgpt-26.1002.51308-darwin-aarch64/bin/macos-aarch64/codex`, ['app-server'], 'codex', `${DF} (codex.vscode, a macOS test machine 2026-10-12)`),
  l('/usr/local/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex', ['codex', 'exec', 'hi'], 'codex', 'test/collector/harness/codex.test.mjs:25'),
  l('/usr/local/bin/node', ['node', '/usr/local/bin/codex', 'exec'], null, 'test/collector/harness/codex.test.mjs:27 (the Node launcher)'),
  w(`${W}\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`, [], 'codex', `${WF} (codex.cli)`),
  w(`${W}\\AppData\\Local\\OpenAI\\Codex\\bin\\0123456789abcdef\\codex.exe`, ['app-server'], 'codex', `${WF} (codex.app)`),
  w(String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.1002.0.0_x64__2p2nqsd0c76g0\app\resources\codex.exe`, ['app-server'], 'codex', `${P} win FD-W1 (MSIX codex.app, Windows test machine)`),
  // ── opencode ──
  d(`${U}/.opencode/bin/opencode`, ['run', 'hi'], 'opencode', `${DF} (opencode.cli)`),
  d(`${U}/Library/Application Support/ai.opencode.desktop/cli/2.0.25/opencode-cli`, ['serve', '--service'], 'opencode', `${DF} (opencode.desktop, mac-matrix-2 run 20261013T042732)`),
  l('/usr/lib/node_modules/opencode-ai/bin/.opencode', ['.opencode'], 'opencode', 'test/collector/harness/opencode.test.mjs:17'),
  l('/usr/bin/node', ['node', '/usr/lib/node_modules/opencode-ai/bin/opencode'], null, 'test/collector/harness/opencode.test.mjs:19 (the Node launcher)'),
  l('/home/u/.opencode/bin/opencode', ['opencode', 'x'], null, 'test/collector/harness/opencode.test.mjs:20 (BUN_BE_BUN self-exec)', new Map([['BUN_BE_BUN', '1']])),
  w(`${W}\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe`, ['run', 'hi'], 'opencode', `${WF} (opencode.cli)`),
  w(`${W}\\AppData\\Local\\Programs\\OpenCode\\resources\\opencode-cli.exe`, ['serve'], 'opencode', `${P} win PS-F6 (the desktop's core)`),
  w(`${W}\\AppData\\Local\\Programs\\@opencodedesktop\\OpenCode.exe`, [], 'opencode', 'desktop · win: OpenCode.exe is the name opencode, the same item as the CLI; the old opencode.desktop form matched it'),
  // ── deepseek-dsh ──
  d('/usr/local/bin/node', [`${U}/.nvm/versions/node/v22.20.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`], 'deepseek-dsh', `${DF} (deepseek-dsh.cli)`),
  d('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', [], 'deepseek-dsh', `${S46} (deepseek harness: the desktop main process)`),
  d('/Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper (Renderer).app/Contents/MacOS/DeepSeek Harness Helper (Renderer)', ['--type=renderer'], null, `${S46} (the desktop helper and its renderer / gpu do not count)`),
  l('/usr/bin/env', ['/usr/bin/env', 'node', '/usr/local/bin/dsh', 'headless'], null, 'test/collector/harness/deepseek-dsh.test.mjs:18 (env before its second exec)'),
  l('/home/u/.nvm/versions/node/v22.19.0/bin/node (deleted)', ['node', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'tui'], 'deepseek-dsh', 'test/collector/harness/deepseek-dsh.test.mjs:20'),
  l('/usr/bin/node', ['node', '--use-openssl-ca', '/usr/local/bin/dsh', 'tui'], 'deepseek-dsh', 'test/collector/harness/deepseek-dsh.test.mjs:21 (node flags before the entry)'),
  w(String.raw`C:\Program Files\nodejs\node.exe`, [`${W}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`], 'deepseek-dsh', `${WF} (deepseek-dsh.cli, the .cmd shim)`),
  w(String.raw`C:\Program Files\nodejs\node.exe`, ['C:/Users/u/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'], 'deepseek-dsh', `${P} win PS-F1 (dsh.ps1 passes forward slashes)`),
  // ── hermes ──
  d(`${U}/.hermes/tools/python-3.12.4/bin/python3`, ['-I', '-c', HERMES_BOOT], 'hermes', `${DF} (hermes.cli)`),
  d(`${U}/.hermes/tools/python-3.12.4/bin/python3`, ['-I', '-m', 'tui_gateway.entry'], 'hermes', `${DF} (hermes.cli, the TUI gateway)`),
  d(`${U}/.hermes/tools/python-3.14.7+20260901-darwin-arm64/bin/python3.14`, ['-I', '-c', HERMES_BOOT], 'hermes', `${DF} (hermes.cli, a macOS test machine 2026-10-12: bin/python3 -> python3.14)`),
  l('/home/u/.hermes/tools/python-3.12.4/bin/python3', ['python3', '-m', 'tui_gateway.slash_worker', '--session-key', 'k', '--parent-pid', '7'], 'hermes', 'test/collector/harness/hermes.test.mjs:36'),
  l('/usr/bin/python3', ['python3', '-c', 'import json'], null, `${S46} (other python -c probes do not count)`),
  w(`${W}\\AppData\\Local\\hermes\\installs\\a1b2c3\\environments\\d4e5f6\\venv\\Scripts\\python.exe`, ['-I', '-c', HERMES_BOOT], 'hermes', `${P} (the installs\\…\\venv layout)`),
  w(`${W}\\AppData\\Local\\hermes\\tools\\python-3.14.7+20260901-win32-x64\\python.exe`, ['-I', `${W}\\AppData\\Local\\hermes\\bin\\hermes.exe`, '-z', 'hi'], 'hermes', 'a Windows test machine, 2026-10-14 (hermes.exe execs python -I <the launcher>)'),
  w(`${W}\\AppData\\Local\\hermes\\tools\\python-3.14.7+20260901-win32-x64\\python.exe`, ['-I', '-I', '-c', String.raw`import sys, runpy; sys.path.insert(0, 'C:\\Users\\u\\AppData\\Local\\hermes\\hermes-agent'); sys.argv = ['C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe', '-z', 'hi']; runpy.run_path('C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe', run_name='__main__')`], 'hermes', 'a Windows test machine, 2026-10-14 (the launcher python runs itself again through runpy)'),
  w(`${W}\\AppData\\Local\\hermes\\installs\\9d6e\\pm-runtime\\generations\\fadb\\Scripts\\python.exe`, ['-I', '-B', `${W}\\AppData\\Local\\hermes\\hermes-agent\\pm\\worker.py`], null, 'a Windows test machine, 2026-10-14 (a package-manager worker is not the agent: forwarded)'),
  w(String.raw`C:\Users\Jo Smith\AppData\Local\hermes\tools\python-3.14.7+20260901-win32-x64\python.exe`, ['-I', String.raw`C:\Users\Jo Smith\AppData\Local\hermes\bin\hermes-acp.exe`], 'hermes', 'a Windows test machine, 2026-10-14 (the ACP launcher; a profile path with a space)'),
  w(`${W}\\AppData\\Local\\hermes\\tools\\python-3.14.7+20260901-win32-x64\\python.exe`, ['-m', 'hermes_cli.main', 'gateway', 'run'], 'hermes', 'the gateway service: Hermes_Gateway.vbs, login item, scheduled task'),
  w(`${W}\\AppData\\Local\\hermes\\tools\\python-3.14.7+20260901-win32-x64\\python.exe`, ['-I', '-c', "import base64; exec(base64.b64decode('aW1wb3J0IGhlcm1lc19ib290c3RyYXA='))", 'serve', '--host', '127.0.0.1', '--port', '0'], 'hermes', 'the desktop source build: Hermes.exe → hermes.cmd serve → this python'),
  w(`${W}\\AppData\\Local\\Programs\\Python\\Python312\\python.exe`, ['-I', '-c', "import base64; exec(base64.b64decode('cHJpbnQoMSk='))"], null, '(a base64 one-liner without the serve subcommand is not Hermes)'),
  w(`${W}\\AppData\\Local\\Programs\\Python\\Python312\\python.exe`, ['-I', '-c', "import base64; exec(base64.b64decode('cHJpbnQoMSk='))", 'serve', '--port', '8000'], null, 'review (a base64 one-liner serving on another address is not Hermes)'),
  l('/home/u/.hermes/tools/python-3.12.4/bin/python3', ['python3', '-m', 'hermes_cli.main', 'gateway', 'run'], 'hermes', 'review (the win-measured gateway shape names Hermes on Linux too: D51 names have no OS; Linux run UNT)'),
  l('/usr/bin/python3', ['python3', '-m', 'hermes_cli.main', 'serve'], null, 'review (only the measured gateway verb of the CLI module counts)'),
  w(`${W}\\AppData\\Local\\Programs\\Python\\Python312\\python.exe`, ['-I', '-c', String.raw`import runpy; runpy.run_path('C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe.bak')`], null, 'review 2026-10-14 (a runpy of a file that only starts with hermes.exe is not Hermes)'),
  w(`${W}\\AppData\\Local\\Programs\\Python\\Python312\\python.exe`, ['-I', `${W}\\tools\\notes.exe`], null, 'a Windows test machine, 2026-10-14 (python -I running another zip launcher is not Hermes)'),
  // ── kimi-code ──
  d(`${U}/.kimi-code/bin/kimi`, ['-p', 'hi'], 'kimi-code', `${DF} (kimi-code.cli)`),
  l('/home/u/.kimi-code/bin/kimi', ['kimi-code'], 'kimi-code', 'test/collector/harness/kimi-code.test.mjs:25 (argv rewritten to the title, acceptance ③)'),
  l('/usr/bin/node', ['node', '/usr/local/bin/kimi', '-p', 'hi'], 'kimi-code', 'test/collector/harness/kimi-code.test.mjs:28 (the npm bin symlink through env node)'),
  l('/usr/bin/node', ['node', '/usr/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs'], 'kimi-code', 'test/collector/harness/kimi-code.test.mjs:29'),
  w(`${W}\\.kimi-code\\bin\\kimi.exe`, ['-p', 'hi'], 'kimi-code', `${WF} (kimi-code.cli)`),
  // ── pi ── (macOS and Windows; Linux not measured yet)
  d(MNODE, [], 'pi', `${PIM} (the managed install once pi retitles itself: argv is its title, the exe stays node)`, 'pi'),
  d(MNODE, ['', ''], 'pi', `${PIM} (--mode rpc keeps the title pi; the rest of the overwritten argv is empty)`, 'pi'),
  d(MNODE, [], 'pi', `${PIM} (the package's rpc-entry.js retitles itself pi-rpc)`, 'pi-rpc'),
  d(MNODE, [`${U}/.local/bin/../../.pi/agent/install/releases/1.4.0/node_modules/.bin/pi`, '-p', 'hi'], 'pi', `${PIM} (the managed install before the retitle: the sh launcher execs node on the unresolved path)`, 'node'),
  d(MNODE, [`${U}/.npm-global/bin/pi`, '-p', 'hi'], 'pi', `${PIM} (npm's install before the retitle: argv names the invoked link, not cli.js)`, 'node'),
  d(MNODE, ['dist/cli.js', '--mode', 'rpc'], 'pi', `${PIM} (pi's RpcClient with its default cliPath, before the retitle: cli.js relative to the package as cwd)`, 'node'),
  d(MNODE, [`${U}/proj/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`, '--mode', 'rpc'], 'pi', "pi 1.4.0 source (an RpcClient caller passes the package's cli.js as an absolute cliPath; the shape before the retitle)", 'node'),
  d(MNODE, [`${U}/work/other-tool/dist/cli.js`, '--mode', 'rpc'], null, "another package's absolute dist/cli.js in rpc mode is not pi: only the relative entry with the rpc flag is", 'node'),
  d('/bin/bash', ['-c', 'echo hi'], null, `${PIM} (a tool's bash under pi never connects to a model)`),
  w(NODE, [`${PI_HOME}\\install\\releases\\1.4.0\\node_modules\\${PI_CLI}`, '-p', 'hi'], 'pi', `${PIW} (the managed install: the launcher's child node holds the connection)`),
  w(NODE, [`${PI_HOME}\\install\\releases\\1.4.0\\node_modules\\${PI_CLI}`, '--mode', 'rpc'], 'pi', `${PIW} (the managed install in rpc mode)`),
  w(NODE, [`${PI_HOME}\\bin\\pi-launcher.js`, '-p', 'hi'], null, `${PIW} (the managed launcher waits for its child and never connects)`, { argv: ['node', `${PI_HOME}\\bin\\pi-launcher.js`, '-p', 'hi'], cmdline: `"node" ${PI_HOME}\\bin\\pi-launcher.js -p hi` }),
  w(NODE, [`${W}\\AppData\\Roaming\\npm\\\\node_modules\\${PI_CLI}`], 'pi', `${PIW} (the npm pi.cmd shim: one node, its %dp0% gives a doubled separator)`, { argv: ['node', `${W}\\AppData\\Roaming\\npm\\\\node_modules\\${PI_CLI}`], cmdline: `"node" "${W}\\AppData\\Roaming\\npm\\\\node_modules\\${PI_CLI}"` }),
  w(`${W}\\pi\\pi.exe`, ['-p', 'hi'], 'pi', `${PIW} (the Bun binary: one process)`),
  w(String.raw`C:\Program Files\Git\bin\bash.exe`, ['-c', 'ls'], null, `${PIW} (a tool's Git bash under pi never connects to a model)`),
  // ── z-code ──
  d('/Applications/ZCode.app/Contents/MacOS/ZCode', [ZCJS, 'app-server', '--stdio'], 'z-code', `${DF} (z-code.cli)`),
  d('/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper', [], 'z-code', `${DF} (z-code.desktop: the title zcode-cli, mac-matrix-2 run 20261013T035417)`, 'zcode-cli'),
  d('/Applications/ZCode.app/Contents/MacOS/ZCode', [], null, `${DF} (the GUI itself: the name alone is not the agent)`),
  l('/home/u/.zcode/server/node', ['node', '/home/u/.zcode/server/agents/glm/zcode.cjs', 'app-server'], 'z-code', 'test/collector/harness/z-code.test.mjs:30 (remote mode)'),
  l('/usr/local/bin/node', ['node', '/srv/zcode.cjs'], null, 'test/collector/harness/z-code.test.mjs:40 (not under glm/)'),
  w(`${W}\\AppData\\Local\\Programs\\ZCode\\ZCode.exe`, ['C:\\r\\resources\\glm\\zcode.cjs', 'app-server', '--stdio'], 'z-code', `${WF} (z-code.cli)`),
  w(`${W}\\AppData\\Local\\Programs\\ZCode\\ZCode.exe`, NET, 'z-code', `${S46} (zcode + the Chromium network service args, win32 desktop)`),
]
