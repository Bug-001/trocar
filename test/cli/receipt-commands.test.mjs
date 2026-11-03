// test/cli/receipt-commands.test.mjs — 1.6 §1.1 rules 5 and 6 and §3.6, over the pure renderers (receipt.mjs): a row's `command` (on's blocked[],
// uninstall's left[]) is printed whole on a line of its own, never folded on its spaces (a paste of a folded sudo line runs sudo alone); every text line
// shows HOME paths as ~, and a command does where the shell expands it; the purge hint is there exactly when something is kept.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fit, formatOnReceipt, formatUninstallReceipt } from '../../src/cli/receipt.mjs'
import { newReceipt } from '../../src/cli/schema.mjs'

const HOMES = ['/home/alice', '/Users/admin', 'C:\\Users\\John Smith']
const sep = (home) => (home.includes('\\') ? '\\' : '/')
// a command longer than a line, with spaces in it, naming paths under HOME: what selfCommand gives for a script install
const longCommand = (home) => `sudo ${home}${sep(home)}.trocar${sep(home)}app${sep(home)}current${sep(home)}node${sep(home)}bin${sep(home)}node ${home}${sep(home)}.trocar${sep(home)}app${sep(home)}current${sep(home)}bin${sep(home)}trocar.mjs setup-helper --remove`
const lines = (text) => text.split('\n')

for (const home of HOMES) {
  test(`§1.1⑥ a row's command is one whole line (${home}): on's blocked[], uninstall's left[]`, () => {
    const cmd = longCommand(home)
    const on = { ...newReceipt('on'), ok: false, harnesses: [], refused: [], routes: [], changed: [], created: [], skipped: [], restart: [], notes: ['the capability helper is missing (no helper); nothing was changed. Install it with the line below, then run trocar on again'], blocked: [{ what: 'trocar on', reason: 'r', command: cmd }] }
    assert.ok(lines(formatOnReceipt(on, { home })).some((l) => l.trim() === cmd), formatOnReceipt(on, { home }))
    const un = { ...newReceipt('uninstall'), ok: false, kept: [], left: [{ what: 'the capability helper', path: '/usr/local/libexec/trocar/redirector', reason: `still installed; ${home}${sep(home)}.trocar${sep(home)}app stays too. Remove the helper with this line, then run trocar uninstall again:`, command: cmd }], problems: [], notes: [] }
    const text = formatUninstallReceipt(un, { home, platform: 'linux' })
    assert.ok(lines(text).some((l) => l.trim() === cmd), text)
  })

  test(`§1.1⑤ every text line shows HOME as ~ (${home}); a sibling directory is left as it is`, () => {
    const s = sep(home)
    const out = fit([`autostart  ${home}${s}Library${s}LaunchAgents${s}com.trocar.collector.plist: enabled`, `PATH  ${home}${s}.zshrc: line added`, `Kept: ${home}x${s}other`], { home })
    assert.ok(out.slice(0, 2).every((l) => !l.includes(home) && l.includes(`~${s}`)), out.join('\n'))
    assert.ok(out[2].includes(`${home}x${s}other`), 'a directory whose name only starts like HOME is not HOME')
  })

  test(`§1.1⑤ a command to copy (${home}): HOME as ~ only where sh expands it; a sudo line, a quoted path and a Windows line stay absolute`, () => {
    const s = sep(home), posix = s === '/'
    const off = `${home}${s}.trocar${s}bin${s}trocar-off`
    const [bare, sudo, quoted, sibling, cd, later] = fit([{ command: off }, { command: longCommand(home) }, { command: `node "${off}"` }, { command: `${home}x${s}bin${s}tool` }, { command: `cd ${home}` }, { command: `env A=1 sudo ${off}` }], { home }).map((l) => l.trim())
    assert.equal(bare, posix ? `~${s}.trocar${s}bin${s}trocar-off` : off)
    assert.equal(sudo, longCommand(home), 'a sudo line keeps the absolute paths selfCommand writes (§3.2)')
    assert.equal(cd, posix ? 'cd ~' : `cd ${home}`, 'HOME as a whole word: ~ only where sh expands it')
    assert.equal(later, `env A=1 sudo ${off}`, 'sudo anywhere before the path keeps it absolute (§3.2)')
    assert.equal(quoted, `node "${off}"`, 'a quoted ~ is not expanded')
    assert.equal(sibling, `${home}x${s}bin${s}tool`)
  })
}

test('§3.6 the purge command is given exactly when something is kept, and the hint names each kept thing', () => {
  const K = [{ what: 'your captured records', path: '/h/.trocar/raw', bytes: 1 }, { what: 'the index trocar built from them', path: '/h/.trocar/index', bytes: 1 }, { what: "trocar's record of what it did and what failed", path: '/h/.trocar/collector/flows', bytes: 1 }]
  for (let mask = 0; mask < 1 << K.length; mask++) {
    const kept = K.filter((_, i) => mask & (1 << i))
    const text = formatUninstallReceipt({ ...newReceipt('uninstall'), ok: true, kept, left: [], problems: [], notes: [] }, { home: '/h', platform: 'darwin' })
    const purge = lines(text).filter((l) => l.trim() === 'trocar uninstall --purge-data')
    assert.equal(purge.length, kept.length ? 1 : 0, text)
    const hint = text.slice(0, text.lastIndexOf('trocar uninstall --purge-data')).split('Kept').at(-1).split('\n').slice(kept.length + 1).join(' ').replace(/\s+/g, ' ')
    for (const k of kept) assert.ok(hint.includes(k.what), `the hint names ${k.what}:\n${text}`)
  }
})

// §1.1⑥ columns: a label's items hang two deeper than the label; a command to copy sits deeper than any item, so the same path as an item
// (`trocar's own files:`) and as a command (`If trocar itself breaks, run:`) never look alike. Read off the rendered receipt, not a fixed indent.
test('§1.1⑥ a command to copy is deeper than every list item of the receipt', () => {
  const home = '/home/alice', off = `${home}/.trocar/bin/trocar-off`
  const r = { ...newReceipt('on'), ok: true, harnesses: ['codex'], changed: [], created: [off, `${home}/.trocar/collector/state.json`], unchanged: [], skipped: [], restart: [], notes: [], daemon: { state: 'running', pid: 1 }, standalone: off }
  const out = lines(formatOnReceipt(r, { home, platform: 'linux' }))
  const depth = (l) => l.length - l.trimStart().length
  const label = out.indexOf("trocar's own files:"), cmd = out.indexOf('If trocar itself breaks, run:') + 1
  const items = out.slice(label + 1).filter((l, i, a) => i < a.findIndex((x) => depth(x) === 0))
  assert.ok(items.length === 2 && items.every((l) => depth(l) > 0), out.join('\n'))
  assert.equal(out[cmd].trim(), '~/.trocar/bin/trocar-off')
  assert.ok(items.every((l) => depth(out[cmd]) > depth(l)), `the command is deeper than the items:\n${out.join('\n')}`)
})

// 附录 A.1 for on's route line (§1.1⑥, §3.3): it is one line from column 0 and never folds; a chain too long drops the [labels] first, and only
// then is cut to `agent -> trocar -> <next hop> -> ...` — each tier drawn from the topology itself, so a hop written in brackets (an IPv6 host) is
// never mistaken for a label; the proxy setting it was drawn from is still said
test('A.1 on: a route line never folds; it drops the labels first, then keeps agent, trocar and the next hop', async () => {
  const { renderCompact, BRANCH_SEP } = await import('../../src/netenv/topology-text.mjs')
  const home = '/home/alice'
  const topo = (hops) => {
    const nodes = [{ id: 'a', kind: 'agent', name: 'codex', pid: 5530 }, { id: 't', kind: 'trocar-engine', name: 'trocar', port: 17992, trocar: true }, ...hops.map((h, i) => ({ id: `h${i}`, ...h }))]
    const path = nodes.map((n) => n.id)
    const edges = path.slice(1).map((to, i) => ({ from: path[i], to, via: i === 0 ? 'proxy-http' : (nodes[i + 1].via || 'system-proxy'), ...(i === 0 ? { entry: { where: `${home}/.codex/.env`, opt_in: false } } : {}) }))
    return { harness: 'codex', nodes, edges, branches: [{ name: 'http', path, off_path: path.filter((id) => id !== 't') }] }
  }
  const on = (t) => lines(formatOnReceipt({ ...newReceipt('on'), ok: true, harnesses: ['codex'], changed: [], created: [], unchanged: [], skipped: [], restart: [], notes: [], daemon: { state: 'running', pid: 1 },
    adopted: { codex: { chain: renderCompact(t).join(BRANCH_SEP), proxy: 'http://***@proxy.corp.example.com:8080', source: [{ kind: 'file', where: `${home}/.codex/.env`, key: 'HTTPS_PROXY' }] } } }, { home, topology: { codex: t } }))
  const route = (out) => out.find((l) => l.startsWith('route'))
  const near = topo([{ kind: 'proxy', name: 'proxy.corp.example:8080', port: 8080 }, { kind: 'egress', name: 'internet' }])
  const a = route(on(near))
  assert.ok(a.length <= 80 && !a.includes('['), a)
  assert.ok(['codex (pid 5530)', 'trocar :17992', 'proxy.corp.example:8080', 'internet'].every((h) => a.includes(h)), `dropping the labels was enough, so every hop stays: ${a}`)
  // an IPv6 hop is written in brackets: it is a host the line must print, not a label to drop
  const v6 = topo([{ kind: 'upstream', name: '[::1]', via: 'direct' }])
  const c = route(on(v6))
  assert.ok(c.length <= 80 && c.endsWith('[::1] (direct)'), `the IPv6 host is kept: ${c}`)
  const far = topo([...Array.from({ length: 4 }, (_, i) => ({ kind: 'proxy', name: `hop${i}.example.com:1`, port: 1 })), { kind: 'proxy', name: 'proxy.corp.example:8080', port: 8080 }, { kind: 'egress', name: 'internet' }])
  assert.equal(route(on(far)), 'route: codex (pid 5530) -> trocar :17992 -> hop0.example.com:1 -> ...')
  assert.ok(on(far).join(' ').includes('http://***@proxy.corp.example.com:8080'), 'the proxy setting is still said')
  assert.ok(on(far).every((l) => !/^\s*(-> |internet)/.test(l)), 'nothing of the chain folds onto the next line')
  const huge = topo([{ kind: 'proxy', name: `${'very-long-proxy-name.'.repeat(4)}example:8080`, port: 8080 }, { kind: 'egress', name: 'internet' }])
  const h = on(huge), at = h.findIndex((l) => l.startsWith('route'))
  assert.ok(h[at].endsWith('-> ...') && !/^-> /.test(h[at + 1]), `a line still too long after the last tier stays one line, never folded\n${h.join('\n')}`)
})

// §1.1⑤⑥: a receipt's rows are laid out at the width they print with — a HOME path inside a value is measured as ~/…, so a word that fits the value
// column once shortened is never dropped to the fold column (a Linux install's Changed: row and its plan's SSL_CERT_FILE rows did)
test('the rows of on / install measure a HOME path as it is printed (~), so every line of a value starts in its value column', async () => {
  const { changeLines, formatPlan } = await import('../../src/cli/receipt.mjs')
  const home = '/home/a-rather-long-account-name'
  const valueCol = (out, first) => { const i = out.findIndex((l) => l.includes(first)); return { i, col: out[i].indexOf(first) } }
  const changed = fit(changeLines({ changed: [{ path: `${home}/.dsh/cordis.patch.yml`, change: `one line added (- insert: [{ name: "${home}/.trocar/collector/plugins/dsh/index.js" }])`, backup: null }], created: [] }, { home }), { home })
  const plan = lines(formatPlan({ entries: ['codex', 'hermes'].map((h) => ({ harness: h, path: `${home}/.${h}/.env`, keys: ['SSL_CERT_FILE'], what: `SSL_CERT_FILE=${home}/.trocar/collector/ca/combined-${h}.pem` })) }, { home }))
  for (const [out, first] of [[changed, 'one line added'], [plan, '~/.codex/.env']]) {
    const { i, col } = valueCol(out, first)
    const rows = out.slice(i + 1).filter((l) => /^ {3,}/.test(l) && !l.trim().startsWith('~/.hermes') && !/^ {2}\S/.test(l))
    assert.ok(rows.length && rows.every((l) => l.length - l.trimStart().length === col), `every folded line starts at column ${col}\n${out.join('\n')}`)
    assert.ok(out.every((l) => l.length <= 80 && !l.includes(home)), out.join('\n'))
  }
})
