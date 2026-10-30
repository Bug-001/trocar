// CM14 (spec 4.11 hook contract, P8 / P9): a static scan of every hook template — the plugin templates and the wrapper templates. A hook
// may add the trocar root to its own process and route its own connections to the door, recording the prior value; it MUST NOT write
// files (agent config included), connect anywhere but the door (a ProxyAgent to it, or fetch's own `proxy` option), or read or change
// request / response bytes. The routing slots (door, switch file, real program, proxy names) appear in no other source file, so a hook
// carrier cannot grow outside harness/templates and the arch wrapper files. Each rule is also run against a planted violation, so the
// scan can still fail.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const TEMPLATE_DIR = 'src/collector/harness/templates'
const WRAPPERS = ['src/collector/arch/darwin/wrapper.dash.tmpl', 'src/collector/arch/win32/wrapper.cs']
const JS_TEMPLATES = fs.readdirSync(path.join(REPO, TEMPLATE_DIR)).filter((f) => f.endsWith('.tmpl')).map((f) => `${TEMPLATE_DIR}/${f}`)
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')
// Comments say what a hook does not do; only code is scanned.
const code = (text, lang) => (lang === 'sh' ? text.replace(/^\s*#.*$/gm, '') : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1'))

const RULES = {
  js: [
    ['a file write', /\b(write|writeFile|appendFile|append|rename|unlink|rm|rmdir|mkdir|copyFile|cp|symlink|link|truncate|chmod|chown|utimes|createWriteStream|mkdtemp)(Sync)?\s*\(|\bopen(Sync)?\s*\([^)]*['"][wax+]/],
    ['a child process or a raw binding', /child_process|process\.binding|\bexec(File)?(Sync)?\s*\(|\bspawn(Sync)?\s*\(/],
    ['a connection of its own', /\b(net|tls|http|https|http2|dgram)\.(connect|request|get|createConnection|createServer)\b|\bnew\s+WebSocket\b|\bnew\s+[\w.]*\b(Agent|Client|Pool|Socket)\s*\(|\.(connect|request|stream|pipeline)\s*\(|\bfetch\s*\(\s*['"`]/],
    ['reading or changing bytes', /\.(text|json|arrayBuffer|blob|formData|getReader|bytes)\s*\(|\bon(Data|Headers|Complete|BodySent|RequestStart|ResponseStart|ResponseData|ResponseEnd|Upgrade)\b|\b(opts|init|options)\.(body|headers)\s*=|\bbody\s*:/],
  ],
  sh: [
    ['a file write', /(^|[^2])>|\b(tee|dd|mv|cp|rm|mkdir|touch|ln|install|chmod|sed)\b/m],
    ['a connection of its own', /\b(curl|wget|nc|ncat|socat|openssl|ssh|telnet)\b|\/dev\/tcp/],
    ['a command other than the real program', /\b(env|sh|bash|zsh|node|python3?|perl|osascript|open|launchctl|defaults|security)\s/],
  ],
  cs: [
    ['a file write', /\bFile\.(Write|Append|Create|Delete|Move|Copy|Replace|Open(?!Read))|\bDirectory\.(Create|Delete|Move)|\bStreamWriter\b|\bFileStream\b|\bRegistry\b/],
    ['a connection of its own', /\b(Socket|TcpClient|UdpClient|WebClient|HttpClient|WebRequest|HttpWebRequest|NamedPipe\w*)\b/],
    ['a second program', /\bProcess\.Start\b|ShellExecute/],
  ],
}
const langOf = (rel) => (rel.endsWith('.dash.tmpl') ? 'sh' : rel.endsWith('.cs') ? 'cs' : 'js')
const violations = (rel, text) => RULES[langOf(rel)].filter(([, re]) => re.test(code(text, langOf(rel)))).map(([what]) => `${rel}: ${what}`)

const DOOR_ID = /^(d|door|DOOR)$/
// the identifier each route points at: a ProxyAgent's uri, fetch's proxy option, or `env[k] = <id>` over PROXY_NAMES
const routes = (c) => [
  ...c.matchAll(/new\s+[\w.]*ProxyAgent\s*\(\s*\{\s*uri:\s*(\w+)/g),
  ...c.matchAll(/proxy:\s*(\w+)\s*\}/g),
  ...c.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+PROXY_NAMES\s*\)\s*\w+\[\1\]\s*=\s*(\w+)/g),
].map((m) => m.at(-1))

test('CM14 hook contract: no template writes a file, connects anywhere but the door, or touches request / response bytes', () => {
  assert.ok(JS_TEMPLATES.length >= 2)
  for (const rel of [...JS_TEMPLATES, ...WRAPPERS]) assert.deepEqual(violations(rel, read(rel)), [], rel)
  // the JS templates' only route is the door: a ProxyAgent to it, fetch's own proxy option, or the proxy names pointed at it
  for (const rel of JS_TEMPLATES) {
    const r = routes(code(read(rel), 'js'))
    assert.ok(r.length >= 1, `${rel}: it routes somewhere`)
    assert.deepEqual(r.filter((id) => !DOOR_ID.test(id)), [], `${rel}: every route goes to the door`)
  }
})

test('CM14 the scan fails on a planted violation of every rule', () => {
  const PLANTS = {
    js: ["fs.writeFileSync('/x', 'y')", "import('node:child_process')", "https.request('https://evil')", "res.text()", "opts.body = 'x'", "new u.Agent()"],
    sh: ['echo x > ~/.kimi/config', 'curl https://x', 'env -i kimi'],
    cs: ['File.WriteAllText(p, s);', 'new HttpClient();', 'Process.Start("x");'],
  }
  for (const [lang, plants] of Object.entries(PLANTS)) {
    const rel = { js: 'x.js.tmpl', sh: 'x.dash.tmpl', cs: 'x.cs' }[lang]
    for (const p of plants) assert.notDeepEqual(violations(rel, p), [], `${lang}: ${p}`)
  }
  assert.deepEqual(violations('x.dash.tmpl', 'IFS= read -r d 2>/dev/null <"$1"'), [], 'reading the switch file, errors silenced, is allowed')
  for (const p of ['for (const k of PROXY_NAMES) env[k] = upstream', 'new u.ProxyAgent({ uri: other })', 'inner(input, { proxy: other })']) {
    assert.notDeepEqual(routes(code(p, 'js')).filter((id) => !DOOR_ID.test(id)), [], `a route not to the door: ${p}`)
  }
})

test('CM14 the routing slots live only in harness/templates and the arch wrapper files', () => {
  const walk = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]))
  const SLOTS = /__TROCAR_(DOOR|SWITCH|REAL|PROXY_ENV|PROXY_NAMES|NO_PROXY_ENV)__/
  const carriers = walk('src').filter((rel) => SLOTS.test(read(rel))).sort()
  assert.deepEqual(carriers, [...JS_TEMPLATES, ...WRAPPERS].sort())
})
