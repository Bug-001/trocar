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

