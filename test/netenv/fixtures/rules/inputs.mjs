// Inputs shared by test/netenv/mihomo-rules.test.mjs (4.8 W7 W8 W12): the generator takes data only, so the tests feed it data.
// The path patterns are stand-ins shaped like 4.8 §2.3 (the subset JS and .NET read the same way: escaped literals, [^\\]*, .*, (a|b)); the real
// per-harness data is Task 4's (src/collector/harness/win32/), and test/collector/harness/win32-forms.test.mjs (W3) holds it to the same semantics.
export const TOKEN = '0123456789abcdef0123456789abcdef' // a fixture value, never a real ingress token
export const ENGINE_PORT = 18790
const raw = String.raw

export const CC_CLI = { g: 'claude-code.cli', pathPatterns: [raw`\\@anthropic-ai\\claude-code\\bin\\claude\.exe`, raw`\\\.local\\bin\\claude\.exe`], names: [] }
export const CODEX_APP = { g: 'codex.app', pathPatterns: [raw`\\OpenAI\\Codex\\bin\\[^\\]*\\codex\.exe`], names: [] }
export const KIMI_CLI = { g: 'kimi-code.cli', pathPatterns: [raw`\\\.kimi-code\\bin\\kimi\.exe`], names: ['kimi.exe'] }
export const HERMES_CLI = { g: 'hermes.cli', pathPatterns: [raw`\\hermes\\tools\\python[^\\]*\\python\.exe`], names: [] }

export const STAND_INS = [CC_CLI, CODEX_APP, KIMI_CLI, HERMES_CLI]

/** Images a process rule must reach, and images it must never touch, look like these (4.8 §2.3, §3.5). */
export const IMAGES = {
  ccNpm: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
  ccNative: String.raw`C:\Users\u\.local\bin\claude.exe`,
  codexApp: String.raw`C:\Users\u\AppData\Local\OpenAI\Codex\bin\0123456789abcdef\codex.exe`,
  kimi: String.raw`C:\Users\u\.kimi-code\bin\kimi.exe`,
  hermes: String.raw`C:\Users\u\AppData\Local\hermes\tools\python-3.12.4\python.exe`,
  claudeDesktop: String.raw`C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__abc\app\claude.exe`,
  codeUser: String.raw`C:\Users\u\AppData\Local\Programs\Microsoft VS Code\Code.exe`,
  codeSystem: String.raw`C:\Program Files\Microsoft VS Code\Code.exe`,
  codeInsiders: String.raw`C:\Users\u\AppData\Local\Programs\Microsoft VS Code Insiders\Code - Insiders.exe`,
  engine: String.raw`C:\Program Files\nodejs\node.exe`,
  forwarder: String.raw`C:\Users\u\.asight\bin\asight-forwarder.exe`,
}

/** The own forwarder's inputs (4.8 §3.1, §4.2): two form listeners, one upstream direct, one an http proxy of the user's; the controller on a made-up port with a made-up secret. */
export const SECRET = 'abcdef0123456789abcdef0123456789'
export const FORMS = [
  { g: 'claude-code.cli', port: 18801, upstream: 'direct' },
  { g: 'codex.app', port: 18802, upstream: { type: 'http', host: '127.0.0.1', port: 7897 } },
]
export const forwarder = (over = {}) => ({ forms: FORMS, enginePort: ENGINE_PORT, token: TOKEN, controller: { port: 18899, secret: SECRET }, on: false, ...over })
