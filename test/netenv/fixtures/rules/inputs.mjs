// Inputs shared by test/netenv/mihomo-rules.test.mjs (4.8 W7 W8 W12 W70 W72): the generator takes data only, so the tests feed it data.
// The path patterns are stand-ins shaped like 4.8 §2.3 (the subset JS and .NET read the same way: escaped literals, [^\\]*, .*, (a|b)); the real
// per-harness data is Task 4's (src/collector/harness/win32/), and test/collector/harness/win32-forms.test.mjs (W3) holds it to the same semantics.
import { processRulesOf } from '../../../../src/netenv/mihomo/rules.mjs'

export const TOKEN = '0123456789abcdef0123456789abcdef' // a fixture value, never a real ingress token
export const LISTENER_TOKEN = 'fedcba9876543210fedcba9876543210' // a fixture value: the listener's password, a second secret
export const ENGINE_PORT = 18790
const raw = String.raw

export const CC_CLI = { g: 'claude-code.cli', pathPatterns: [raw`\\@anthropic-ai\\claude-code\\bin\\claude\.exe`, raw`\\\.local\\bin\\claude\.exe`], names: [] }
export const CC_VSCODE = { g: 'claude-code.vscode', pathPatterns: [raw`\\\.vscode\\extensions\\anthropic\.claude-code-[^\\]*\\resources\\native-binary\\claude\.exe`], names: [] }
export const CODEX_APP = { g: 'codex.app', pathPatterns: [raw`\\OpenAI\\Codex\\bin\\[^\\]*\\codex\.exe`], names: [] }
export const KIMI_CLI = { g: 'kimi-code.cli', pathPatterns: [raw`\\\.kimi-code\\bin\\kimi\.exe`], names: ['kimi.exe'] }
export const HERMES_CLI = { g: 'hermes.cli', pathPatterns: [raw`\\hermes\\tools\\python[^\\]*\\python\.exe`], names: [] }
const CODE_EXE = { pathPatterns: [raw`\\Microsoft VS Code[^\\]*\\Code[^\\]*\.exe`], names: [] }
const DESKTOP = { pathPatterns: [raw`\\WindowsApps\\Claude_[^\\]*\\app\\claude\.exe`], names: [] }
const DESKTOP_APP = { pathPatterns: [], names: ['DeepSeek Harness.exe'] }

export const STAND_INS = [CC_CLI, CC_VSCODE, CODEX_APP, KIMI_CLI, HERMES_CLI]

/** Images a process rule must reach, and images it must never touch, look like these (4.8 §2.3, §3.5). */
export const IMAGES = {
  ccNpm: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
  ccNative: String.raw`C:\Users\u\.local\bin\claude.exe`,
  ccVscode: String.raw`C:\Users\u\.vscode\extensions\anthropic.claude-code-2.1.289-win32-x64\resources\native-binary\claude.exe`,
  codexApp: String.raw`C:\Users\u\AppData\Local\OpenAI\Codex\bin\0123456789abcdef\codex.exe`,
  kimi: String.raw`C:\Users\u\.kimi-code\bin\kimi.exe`,
  hermes: String.raw`C:\Users\u\AppData\Local\hermes\tools\python-3.12.4\python.exe`,
  claudeDesktop: String.raw`C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__abc\app\claude.exe`,
  codeUser: String.raw`C:\Users\u\AppData\Local\Programs\Microsoft VS Code\Code.exe`,
  codeSystem: String.raw`C:\Program Files\Microsoft VS Code\Code.exe`,
  codeInsiders: String.raw`C:\Users\u\AppData\Local\Programs\Microsoft VS Code Insiders\Code - Insiders.exe`,
  engine: String.raw`C:\Program Files\nodejs\node.exe`,
  forwarder: String.raw`C:\Users\u\.asight\collector\kernel\asight-forwarder.exe`,
}
export const OWN_IMAGES = [IMAGES.engine, IMAGES.forwarder]

/** The own kernel's inputs (4.8 §3.1, §4.1). The controller is on a made-up port with a made-up secret. */
export const SECRET = 'abcdef0123456789abcdef0123456789'
const form = (f, standIn) => ({ f, rules: processRulesOf(standIn) })

/** A group of two forms that read one entry (Claude Code's settings.json): one listener, one port, one upstream; the forms are told apart by their process rules. */
export const CC_GROUP = { g: 'claude-code.settings', port: 18801, on: true, upstream: 'direct', bypass: [], auth: true, forms: [form('claude-code.cli', CC_CLI), form('claude-code.vscode', CC_VSCODE)] }
/** A group with the user's own http proxy as upstream (credentials), and the bypass table that proxy setting leaves direct: one entry of each kind. */
export const BYPASS = [{ kind: 'local' }, { kind: 'domain-suffix', value: 'corp.example.com' }, { kind: 'ip-cidr', value: '10.0.0.0/8' }, { kind: 'domain', value: 'gateway.internal' }]
export const CODEX_GROUP = { g: 'codex.env', port: 18802, on: true, upstream: { type: 'http', host: '127.0.0.1', port: 7897, username: 'u', password: 'p@ss' }, bypass: BYPASS, auth: true, forms: [form('codex.app', CODEX_APP)] }
/** A group with one form that has no process rule (it takes every connection of its port) beside one that has. */
export const DSH_GROUP = { g: 'deepseek-dsh.env', port: 18803, on: true, upstream: 'direct', bypass: [], auth: true, forms: [{ f: 'deepseek-dsh.cli', rules: [] }, form('deepseek-dsh.desktop', DESKTOP_APP)] }
/** The host tree: a process of a program that carries many extensions, narrowed to the one agent's hosts. */
export const KIMI_GROUP = { g: 'kimi-code.vscode', port: 18804, on: true, upstream: 'direct', bypass: [], auth: true, forms: [{ ...form('kimi-code.vscode', CODE_EXE), hosts: ['api.kimi.com', 'api.moonshot.cn'] }] }
/** An entry that cannot carry credentials (a policy value that takes an address only): no listener users. */
export const DESKTOP_GROUP = { g: 'claude-code.desktop', port: 18805, on: true, upstream: 'direct', bypass: [], auth: false, forms: [form('claude-code.desktop', DESKTOP)] }

export const forwarder = (over = {}) => ({ groups: [CC_GROUP, CODEX_GROUP], enginePort: ENGINE_PORT, token: TOKEN, listenerToken: LISTENER_TOKEN, controller: { port: 18899, secret: SECRET }, ownImages: OWN_IMAGES, ...over })
